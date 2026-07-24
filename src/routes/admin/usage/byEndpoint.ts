import { Router } from 'express';
import type { Pool } from 'pg';
import { adminAuth } from '../../../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../../../middleware/ipAllowlist.js';
import { BadRequestError, InternalServerError } from '../../../errors/index.js';
import { logger } from '../../../logger.js';
import { getClientIp } from '../../../lib/clientIp.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 1000;

const parseDateParam = (value: unknown): Date | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseNumberParam = (
  value: unknown,
  opts: { min: number; max: number; integer: boolean; fallback: number },
): number | null => {
  if (value === undefined) {
    return opts.fallback;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (opts.integer && !Number.isInteger(parsed)) {
    return null;
  }
  if (parsed < opts.min || parsed > opts.max) {
    return null;
  }
  return parsed;
};

interface EndpointUsageRow {
  endpoint: string;
  calls: number;
  revenue: string;
}

export interface AdminUsageByEndpointRouterDeps {
  pool?: Pool;
}

/**
 * Router exposing `GET /api/admin/usage/by-endpoint` — top endpoint usage
 * aggregated across all developers for admin review.
 *
 * Admin-only: gated behind the admin IP allowlist and admin authentication.
 * Queries the `usage_events` table directly for efficient grouped aggregation.
 */
export function createAdminUsageByEndpointRouter(deps: AdminUsageByEndpointRouterDeps = {}): Router {
  const router = Router();

  router.use(createAdminIpAllowlist());
  router.use(adminAuth);

  router.get('/', async (req, res, next) => {
    try {
      const from = parseDateParam(req.query.from);
      if (from === null) {
        next(new BadRequestError('Invalid "from" date'));
        return;
      }
      const to = parseDateParam(req.query.to);
      if (to === null) {
        next(new BadRequestError('Invalid "to" date'));
        return;
      }

      const limit = parseNumberParam(req.query.limit, {
        min: 1,
        max: MAX_LIMIT,
        integer: true,
        fallback: DEFAULT_LIMIT,
      });
      if (limit === null) {
        next(new BadRequestError(`limit must be an integer between 1 and ${MAX_LIMIT}`));
        return;
      }

      if (req.query.apiId !== undefined && typeof req.query.apiId !== 'string') {
        next(new BadRequestError('apiId must be a single string value'));
        return;
      }
      const apiId =
        typeof req.query.apiId === 'string' && req.query.apiId.length > 0
          ? req.query.apiId
          : undefined;

      if (req.query.developerId !== undefined && typeof req.query.developerId !== 'string') {
        next(new BadRequestError('developerId must be a single string value'));
        return;
      }
      const developerId =
        typeof req.query.developerId === 'string' && req.query.developerId.length > 0
          ? req.query.developerId
          : undefined;

      const now = new Date();
      const queryFrom = from ?? new Date(now.getTime() - DEFAULT_WINDOW_MS);
      const queryTo = to ?? now;

      if (queryFrom > queryTo) {
        next(new BadRequestError('from must be before or equal to to'));
        return;
      }

      const { pool } = deps;
      if (!pool) {
        next(new InternalServerError('Database pool not available'));
        return;
      }

      const params: unknown[] = [queryFrom, queryTo];
      const clauses: string[] = ['created_at >= $1', 'created_at <= $2'];

      if (apiId !== undefined) {
        params.push(apiId);
        clauses.push(`api_id = $${params.length}`);
      }

      if (developerId !== undefined) {
        params.push(developerId);
        clauses.push(`developer_id = $${params.length}`);
      }

      params.push(limit);
      const sql = `
        SELECT
          endpoint_id AS endpoint,
          COUNT(*)::int AS calls,
          COALESCE(SUM(amount_usdc), 0)::text AS revenue
        FROM usage_events
        WHERE ${clauses.join(' AND ')}
        GROUP BY endpoint_id
        ORDER BY calls DESC, endpoint ASC
        LIMIT $${params.length}
      `;

      let rows: EndpointUsageRow[];
      try {
        const result = await pool.query<EndpointUsageRow>(sql, params);
        rows = result.rows;
      } catch (dbError) {
        logger.error('[admin.usage.byEndpoint] aggregation query failed', { error: dbError });
        next(new InternalServerError());
        return;
      }

      logger.audit('LIST_USAGE_BY_ENDPOINT', res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        window: { from: queryFrom.toISOString(), to: queryTo.toISOString() },
        apiId,
        developerId,
        limit,
        endpointCount: rows.length,
      });

      res.json({
        data: rows.map((row) => ({
          endpoint: row.endpoint,
          calls: row.calls,
          revenue: row.revenue,
        })),
        period: {
          from: queryFrom.toISOString(),
          to: queryTo.toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createAdminUsageByEndpointRouter;

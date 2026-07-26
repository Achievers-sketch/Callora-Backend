/**
 * Admin audit-log listing with cursor pagination and action replay.
 *
 * Routes:
 *   GET  /api/admin/audit
 *   POST /api/admin/audit/replay
 *
 * Pagination uses stable keyset ordering over (created_at DESC, id DESC).
 * The opaque `cursor` query param encodes the last row's timestamp and id.
 *
 * Replay re-executes a previously logged admin action using the original
 * parameters stored in the audit row's `details` JSON blob.
 */

import { Router } from 'express';
import { getClientIp } from '../../lib/clientIp.js';
import { encodeCursor, parseCursor } from '../../lib/cursorPagination.js';
import {
  cursorPaginatedResponse,
} from '../../lib/pagination.js';
import {
  AppError,
  InternalServerError,
} from '../../errors/index.js';
import { ValidationError } from '../../middleware/validate.js';
import { etagMiddleware } from '../../middleware/etag.js';
import { logger } from '../../logger.js';
import {
  PgAuditLogRepository,
  type AuditLogRepository,
} from '../../repositories/auditLogRepository.js';
import {
  createAdminAuditReplayRouter,
  type AdminAuditReplayRouterDeps,
} from './audit/replay.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const parseOptionalDate = (value: unknown, field: string): Date | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`Invalid "${field}" date`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`Invalid "${field}" date`);
  }

  return date;
};

const parseOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export interface AdminAuditRouterDeps
  extends AdminAuditReplayRouterDeps {
  auditLogRepository?: AuditLogRepository;
}

export function createAdminAuditRouter(deps: AdminAuditRouterDeps = {}): Router {
  const router = Router();
  const auditLogRepository = deps.auditLogRepository ?? new PgAuditLogRepository();

  router.use('/replay', createAdminAuditReplayRouter(deps));

  router.get('/', async (req, res, next) => {
    try {
      const parsedQuery = auditQuerySchema.safeParse(req.query);

      if (!parsedQuery.success) {
        const details = parsedQuery.error.issues.map((issue) => {
          const field = `query.${issue.path.join('.')}`;
          return {
            field,
            message: issue.message,
            code: issue.code.toUpperCase(),
          };
        });
        throw new ValidationError(details);
      }

      const { limit, cursor: rawCursor, event, tenant_id: tenantId, actor, from, to } = parsedQuery.data;

      let afterCursor;
      if (rawCursor !== undefined) {
        afterCursor = parseCursor(rawCursor);
        if (!afterCursor) {
          throw new ValidationError([
            {
              field: 'query.cursor',
              message: 'Invalid cursor format',
              code: 'INVALID_VALUE',
            },
          ]);
        }
      }

      const { entries, hasMore } = await auditLogRepository.findCursor({
        limit,
        afterCursor,
        event,
        tenantId,
        actor,
        from,
        to,
      });

      const nextCursor = hasMore && entries.length > 0
        ? encodeCursor(new Date(entries[entries.length - 1]!.createdAt), entries[entries.length - 1]!.id)
        : undefined;

      const correlationId =
        (typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined) ??
        (typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'] : undefined);

      logger.audit('LIST_AUDIT_LOGS', res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        correlationId,
        filters: { event, tenantId, actor, from, to },
        limit,
        cursorProvided: rawCursor !== undefined,
        count: entries.length,
        hasMore,
      });

      res.json(cursorPaginatedResponse(entries, {
        limit,
        hasMore,
        nextCursor,
      }));
    } catch (error) {
      if (error instanceof AppError || error instanceof ValidationError) {
        next(error);
        return;
      }
      logger.error('Failed to list audit logs:', error);
      next(new InternalServerError());
    }
  });

  return router;
}

import { Router, type Response } from 'express';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors/index.js';
import {
  parsePagination,
  paginatedResponse,
  parseCursorPagination,
  decodeCursor,
  generateCursor,
  cursorPaginatedResponse,
} from '../lib/pagination.js';
import { buildCacheKey, listingsCache, type ListingsCache } from '../lib/listingsCache.js';
import { recordCacheHit, recordCacheMiss } from '../metrics.js';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { bodyValidator } from '../middleware/validate.js';
import { etagMiddleware } from '../middleware/etag.js';
import {
  defaultApiRepository,
  type ApiRepository,
} from '../repositories/apiRepository.js';
import {
  defaultDeveloperRepository,
  type DeveloperRepository,
} from '../repositories/developerRepository.js';
import { apiRegistrationSchema, bulkEndpointsSchema } from '../validators/apiRegistration.js';
import { createRateLimitMiddleware } from '../middleware/rateLimit.js';

export interface ApisRouterDeps {
  apiRepository?: ApiRepository;
  developerRepository?: DeveloperRepository;
  /** Inject a custom cache instance (useful in tests). Defaults to the shared singleton. */
  cache?: ListingsCache;
  /** Optional rate limit middleware for the public API routes. */
  rateLimitMiddleware?: ReturnType<typeof createRateLimitMiddleware>;
}

export function createApisRouter(deps: ApisRouterDeps = {}): Router {
  const router = Router();
  const apiRepository = deps.apiRepository ?? defaultApiRepository;
  const developerRepository = deps.developerRepository ?? defaultDeveloperRepository;
  const cache = deps.cache ?? listingsCache;
  const rateLimitMiddleware = deps.rateLimitMiddleware ?? createRateLimitMiddleware({
    windowMs: 60_000,
    maxRequests: 60,
  });

  router.use(rateLimitMiddleware);

  router.get('/', etagMiddleware, async (req, res, next) => {
    try {
      const query = req.query as Record<string, string>;
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;

      // ── Cursor-based pagination path ───────────────────────────────────────
      if (query.cursor !== undefined && query.cursor.trim() !== '') {
        const { limit, cursor: rawCursor } = parseCursorPagination(query);

        // decodeCursor throws a ValidationError (400) on malformed input.
        const { created_at: cursorCreatedAt, id: cursorId } = decodeCursor(rawCursor!);
        const cursorDate = new Date(cursorCreatedAt);
        const cursorIdNum = parseInt(cursorId, 10);
        if (!Number.isFinite(cursorIdNum) || cursorIdNum <= 0) {
          next(new BadRequestError('Invalid cursor: id component must be a positive integer'));
          return;
        }

        const cacheKey = buildCacheKey({ limit, offset: 0, category, search, cursor: rawCursor });
        const cached = cache.get(cacheKey);
        if (cached !== undefined) {
          recordCacheHit();
          res.json(cached);
          return;
        }

        recordCacheMiss();
        // Fetch limit+1 rows; the repository already applies +1 internally.
        const rows = await apiRepository.listPublic({
          limit,
          category,
          search,
          cursor: { after_created_at: cursorDate, after_id: cursorIdNum },
        });

        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);

        // Generate the next cursor from the last item in this page.
        let nextCursor: string | undefined;
        if (hasMore && pageRows.length > 0) {
          const last = pageRows[pageRows.length - 1];
          nextCursor = generateCursor(last.created_at.toISOString(), String(last.id));
        }

        const response = cursorPaginatedResponse(pageRows, {
          limit,
          nextCursor,
          hasMore,
        });

        cache.set(cacheKey, response);
        res.json(response);
        return;
      }

      // ── Offset-based pagination path (legacy / default) ────────────────────
      const { limit, offset } = parsePagination(query);

      const cacheKey = buildCacheKey({ limit, offset, category, search });
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        recordCacheHit();
        res.json(cached);
        return;
      }

      recordCacheMiss();
      const apis = await apiRepository.listPublic({ limit, offset, category, search });
      const response = paginatedResponse(apis, { limit, offset });

      cache.set(cacheKey, response);
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        next(new BadRequestError('id must be a positive integer'));
        return;
      }

      const api = await apiRepository.findById(id);
      if (!api) {
        next(new NotFoundError('API not found or not active'));
        return;
      }

      const endpoints = await apiRepository.getEndpoints(id);

      res.json({
        id: api.id,
        name: api.name,
        description: api.description,
        base_url: api.base_url,
        logo_url: api.logo_url,
        category: api.category,
        status: api.status,
        developer: api.developer,
        endpoints,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/',
    requireAuth,
    bodyValidator(apiRegistrationSchema),
    async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const developer = await developerRepository.findByUserId(user.id);
        if (!developer) {
          next(new BadRequestError('Developer profile not found. Create a developer profile first.', 'DEVELOPER_NOT_FOUND'));
          return;
        }

        const payload = apiRegistrationSchema.parse(req.body);
        const api = await apiRepository.createWithEndpoints({
          developer_id: developer.id,
          name: payload.name,
          description: payload.description ?? null,
          base_url: payload.base_url,
          category: payload.category,
          status: 'active',
          endpoints: payload.endpoints.map((endpoint) => ({
            path: endpoint.path,
            method: endpoint.method,
            price_per_call_usdc: endpoint.price_per_call_usdc,
            description: endpoint.description ?? null,
          })),
        });

        res.status(201).json(api);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/:id/endpoints/bulk',
    requireAuth,
    bodyValidator(bulkEndpointsSchema),
    async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const apiId = Number(req.params.id);
        if (!Number.isInteger(apiId) || apiId <= 0) {
          next(new BadRequestError('id must be a positive integer'));
          return;
        }

        const developer = await developerRepository.findByUserId(user.id);
        if (!developer) {
          next(
            new BadRequestError(
              'Developer profile not found. Create a developer profile first.',
              'DEVELOPER_NOT_FOUND',
            ),
          );
          return;
        }

        const developerApis = await apiRepository.listByDeveloper(developer.id);
        const api = developerApis.find((a) => a.id === apiId);
        if (!api) {
          next(new NotFoundError('API not found'));
          return;
        }

        const payload = bulkEndpointsSchema.parse(req.body);
        const endpoints = await apiRepository.bulkCreateEndpoints(
          apiId,
          payload.endpoints.map((ep) => ({
            path: ep.path,
            method: ep.method,
            price_per_call_usdc: ep.price_per_call_usdc,
            description: ep.description ?? null,
          })),
        );

        res.status(201).json({ endpoints });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createApisRouter();

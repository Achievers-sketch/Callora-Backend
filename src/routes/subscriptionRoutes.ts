import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { createRateLimitMiddleware } from '../middleware/rateLimit.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../errors/index.js';
import type { SubscriptionRepository } from '../repositories/subscriptionRepository.js';
import type { ApiRepository } from '../repositories/apiRepository.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';

// ---------------------------------------------------------------------------
// Async handler helper
// ---------------------------------------------------------------------------

function asyncHandler(
  fn: (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ) => Promise<void>,
) {
  return (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface SubscriptionRoutesDeps {
  subscriptionRepository: SubscriptionRepository;
  apiRepository: ApiRepository;
  developerRepository: DeveloperRepository;
  /** Rate limit window in ms (default: 60_000). */
  rateLimitWindowMs?: number;
  /** Max requests per window (default: 30). */
  rateLimitMaxRequests?: number;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createSubscriptionSchema = z.object({
  api_id: z.number().int().positive(),
  metering_limit: z.number().int().positive().nullable().optional(),
});

const updateSubscriptionSchema = z
  .object({
    status: z.enum(['active', 'paused']).optional(),
    metering_limit: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

const listQuerySchema = z.object({
  status: z.enum(['active', 'paused', 'cancelled']).optional(),
});

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createSubscriptionRouter(deps: SubscriptionRoutesDeps): Router {
  const router = Router();
  const { subscriptionRepository, apiRepository, developerRepository } = deps;

  // Per-user token-bucket rate limit. Configurable via deps for testing.
  const subscriptionRateLimit = createRateLimitMiddleware({
    windowMs: deps.rateLimitWindowMs ?? 60_000,
    maxRequests: deps.rateLimitMaxRequests ?? 30,
  });

  // Apply rate limiting to all subscription routes
  router.use(subscriptionRateLimit);

  // -------------------------------------------------------------------------
  // POST /api/subscriptions
  // Subscribe the authenticated user to a marketplace API.
  // -------------------------------------------------------------------------
  router.post(
    '/',
    requireAuth,
    validate({ body: createSubscriptionSchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const body = createSubscriptionSchema.parse(req.body);

      // Verify the API exists
      const api = await apiRepository.findRawById(body.api_id);
      if (!api) {
        throw new NotFoundError(`API ${body.api_id} not found`);
      }

      // Prevent subscribing to a soft-deleted API
      if (api.deleted_at !== null && api.deleted_at !== undefined) {
        throw new NotFoundError(`API ${body.api_id} not found`);
      }

      // Prevent subscribing to your own API
      const developer = await developerRepository.findByUserId(user.id);
      if (developer && api.developer_id === developer.id) {
        throw new ForbiddenError('You cannot subscribe to your own API', 'FORBIDDEN');
      }

      // Enforce uniqueness: no active/paused subscription already exists
      const existing = await subscriptionRepository.findActiveByUserAndApi(user.id, body.api_id);
      if (existing) {
        throw new ConflictError('You already have an active subscription for this API');
      }

      const subscription = await subscriptionRepository.create({
        user_id: user.id,
        api_id: body.api_id,
        metering_limit: body.metering_limit ?? null,
      });

      res.status(201).json(subscription);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/subscriptions
  // List subscriptions for the authenticated user.
  // -------------------------------------------------------------------------
  router.get(
    '/',
    requireAuth,
    validate({ query: listQuerySchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const query = listQuerySchema.parse(req.query);

      let subscriptions = await subscriptionRepository.findByUserId(user.id);

      if (query.status) {
        subscriptions = subscriptions.filter((s) => s.status === query.status);
      }

      res.json({ data: subscriptions, total: subscriptions.length });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/subscriptions/:id
  // Get a single subscription (must belong to the authenticated user).
  // -------------------------------------------------------------------------
  router.get(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const subscription = await subscriptionRepository.findById(req.params.id);
      if (!subscription) {
        throw new NotFoundError('Subscription not found');
      }

      if (subscription.user_id !== user.id) {
        throw new ForbiddenError('Access denied');
      }

      res.json(subscription);
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/subscriptions/:id
  // Update metering preferences or pause/resume a subscription.
  // -------------------------------------------------------------------------
  router.patch(
    '/:id',
    requireAuth,
    validate({ body: updateSubscriptionSchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const subscription = await subscriptionRepository.findById(req.params.id);
      if (!subscription) {
        throw new NotFoundError('Subscription not found');
      }

      if (subscription.user_id !== user.id) {
        throw new ForbiddenError('Access denied');
      }

      if (subscription.status === 'cancelled') {
        throw new BadRequestError('Cannot modify a cancelled subscription');
      }

      const body = updateSubscriptionSchema.parse(req.body);

      const updated = await subscriptionRepository.update(req.params.id, body);
      if (!updated) {
        throw new NotFoundError('Subscription not found');
      }

      res.json(updated);
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/subscriptions/:id
  // Cancel a subscription (soft-delete; sets status to 'cancelled').
  // -------------------------------------------------------------------------
  router.delete(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const subscription = await subscriptionRepository.findById(req.params.id);
      if (!subscription) {
        throw new NotFoundError('Subscription not found');
      }

      if (subscription.user_id !== user.id) {
        throw new ForbiddenError('Access denied');
      }

      if (subscription.status === 'cancelled') {
        throw new BadRequestError('Subscription is already cancelled');
      }

      const cancelled = await subscriptionRepository.cancel(req.params.id);
      if (!cancelled) {
        throw new NotFoundError('Subscription not found');
      }

      res.json(cancelled);
    }),
  );

  return router;
}

/**
 * Refunds router — developer-facing endpoints for refund requests.
 *
 * Mounted at /api/refunds in app.ts.
 *
 * Routes:
 *   POST   /api/refunds           — Submit a new refund request
 *   GET    /api/refunds           — List the caller's own refund requests
 *   GET    /api/refunds/:id       — Fetch a single refund request by ID
 *   POST   /api/refunds/:id/approve — Admin approves a refund request
 *
 * Security: all routes require user authentication (JWT Bearer or x-user-id header).
 * Users can only see their own requests; cross-user access returns 404.
 * Admin routes require admin authentication.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { logger } from '../logger.js';
import { NotFoundError, UnauthorizedError, ForbiddenError, BadRequestError } from '../errors/index.js';
import { withSpan } from '../otel/spans.js';

const router = Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const refundStatusEnum = z.enum(['pending', 'approved', 'rejected']);

const createRefundSchema = z.object({
  usageEventId: z.string().uuid('usageEventId must be a valid UUID'),
  reason: z.string().min(10, 'Reason must be at least 10 characters').max(1000, 'Reason must not exceed 1000 characters'),
  amountUsdc: z.string().regex(/^\d+(\.\d{1,7})?$/, 'amountUsdc must be a positive decimal with at most 7 fractional places'),
}).strict();

const refundParamsSchema = z.object({
  id: z.string().uuid('Invalid refund ID format'),
}).strict();

const approveRefundSchema = z.object({
  resolution: z.enum(['APPROVED', 'REJECTED']),
  adminNotes: z.string().max(500).optional(),
}).strict();

// ---------------------------------------------------------------------------
// In-memory store for refunds (replace with DB repository in production)
// ---------------------------------------------------------------------------

interface RefundRequest {
  id: string;
  developerId: string;
  usageEventId: string;
  reason: string;
  amountUsdc: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  adminNotes?: string;
}

const refundStore = new Map<string, RefundRequest>();

function generateId(): string {
  return uuidv4();
}

function getRefundStore() {
  return refundStore;
}

function clearRefundStore() {
  refundStore.clear();
}

// Export for testing
export { getRefundStore, clearRefundStore, type RefundRequest };

// ---------------------------------------------------------------------------
// POST /api/refunds — Submit a new refund request
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/refunds:
 *   post:
 *     summary: Submit a new refund request
 *     description: Creates a refund request for a usage event. The request is created in pending state and queued for admin review.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [usageEventId, reason, amountUsdc]
 *             properties:
 *               usageEventId:
 *                 type: string
 *                 format: uuid
 *               reason:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 1000
 *               amountUsdc:
 *                 type: string
 *                 pattern: '^\d+(\.\d{1,7})?$'
 *     responses:
 *       201:
 *         description: Refund request created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/RefundRequest'
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/',
  requireAuth,
  validate({ body: createRefundSchema }),
  async (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => {
    try {
      await withSpan({ name: 'POST /api/refunds', req }, async () => {
        const user = res.locals.authenticatedUser;
        if (!user) {
          throw new UnauthorizedError();
        }

        const body = createRefundSchema.parse(req.body);
        const amount = Number(body.amountUsdc);
        if (amount <= 0) {
          throw new BadRequestError('amountUsdc must be a positive number');
        }

        const refund: RefundRequest = {
          id: generateId(),
          developerId: user.id,
          usageEventId: body.usageEventId,
          reason: body.reason,
          amountUsdc: body.amountUsdc,
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        refundStore.set(refund.id, refund);

        logger.info('Refund request created', {
          refundId: refund.id,
          developerId: user.id,
          usageEventId: body.usageEventId,
          amountUsdc: body.amountUsdc,
        });

        res.status(201).json({ data: refund });
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/refunds — List the caller's own refund requests
// ---------------------------------------------------------------------------

const listRefundsQuerySchema = z.object({
  status: refundStatusEnum.optional(),
  limit: z.string().default('20').transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  offset: z.string().default('0').transform(Number).pipe(z.number().int().min(0)).optional(),
}).strict();

/**
 * @openapi
 * /api/refunds:
 *   get:
 *     summary: List the caller's own refund requests
 *     description: Returns a paginated list of refund requests for the authenticated developer. Optionally filter by status.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, approved, rejected]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 100
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *     responses:
 *       200:
 *         description: List of refund requests
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/RefundRequest'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *       400:
 *         description: Invalid query parameters
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  requireAuth,
  validate({ query: listRefundsQuerySchema }),
  async (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => {
    try {
      await withSpan({ name: 'GET /api/refunds', req }, async () => {
        const user = res.locals.authenticatedUser;
        if (!user) {
          throw new UnauthorizedError();
        }

        const query = listRefundsQuerySchema.parse(req.query);
        const statusFilter = query.status;
        const limit = query.limit ?? 20;
        const offset = query.offset ?? 0;

        const allRefunds = Array.from(refundStore.values())
          .filter((r) => r.developerId === user.id)
          .filter((r) => !statusFilter || r.status === statusFilter)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        const total = allRefunds.length;
        const data = allRefunds.slice(offset, offset + limit);

        logger.info('Refund requests listed', {
          developerId: user.id,
          count: data.length,
          total,
          statusFilter,
        });

        res.json({ data, meta: { total, limit, offset } });
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/refunds/:id — Fetch a single refund request by ID
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/refunds/{id}:
 *   get:
 *     summary: Fetch a single refund request by ID
 *     description: Returns a refund request by its ID. The caller must own the request; a request belonging to another developer is returned as 404 to avoid leaking resource IDs.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Refund request details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/RefundRequest'
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Refund request not found or not owned by caller
 */
router.get(
  '/:id',
  requireAuth,
  validate({ params: refundParamsSchema }),
  async (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => {
    try {
      await withSpan({ name: 'GET /api/refunds/:id', req }, async () => {
        const user = res.locals.authenticatedUser;
        if (!user) {
          throw new UnauthorizedError();
        }

        const { id } = refundParamsSchema.parse(req.params);
        const refund = refundStore.get(id);

        if (!refund) {
          throw new NotFoundError('Refund request not found', 'REFUND_NOT_FOUND');
        }

        // Ownership guard: treat another developer's request as 404 to avoid leaking whether a given ID exists
        if (refund.developerId !== user.id) {
          throw new NotFoundError('Refund request not found', 'REFUND_NOT_FOUND');
        }

        logger.info('Refund request fetched', {
          refundId: refund.id,
          developerId: user.id,
        });

        res.json({ data: refund });
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/refunds/:id/approve — Admin approves/rejects a refund request
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/refunds/{id}/approve:
 *   post:
 *     summary: Admin approves or rejects a refund request
 *     description: Resolves a pending refund request. Requires admin authentication.
 *     security:
 *       - adminApiKey: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [resolution]
 *             properties:
 *               resolution:
 *                 type: string
 *                 enum: [APPROVED, REJECTED]
 *               adminNotes:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: Refund request resolved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   $ref: '#/components/schemas/RefundRequest'
 *       400:
 *         description: Invalid resolution value or already resolved
 *       401:
 *         description: Unauthorized admin request
 *       404:
 *         description: Refund request not found
 *       409:
 *         description: Refund request already resolved
 */
router.post(
  '/:id/approve',
  adminAuth,
  validate({ params: refundParamsSchema, body: approveRefundSchema }),
  async (req: Request, res: Response<unknown>, next: NextFunction) => {
    try {
      await withSpan({ name: 'POST /api/refunds/:id/approve', req }, async () => {
        const { id } = refundParamsSchema.parse(req.params);
        const body = approveRefundSchema.parse(req.body);

        const refund = refundStore.get(id);
        if (!refund) {
          throw new NotFoundError('Refund request not found', 'REFUND_NOT_FOUND');
        }

        if (refund.status !== 'pending') {
          throw new BadRequestError('Refund request has already been resolved', 'REFUND_ALREADY_RESOLVED');
        }

        const adminActor = (res.locals as { adminActor?: string }).adminActor;
        if (!adminActor) {
          throw new ForbiddenError('Admin authentication required');
        }

        refund.status = body.resolution === 'APPROVED' ? 'approved' : 'rejected';
        refund.resolvedAt = new Date();
        refund.updatedAt = new Date();
        refund.resolvedBy = adminActor;
        refund.adminNotes = body.adminNotes;

        logger.audit('REFUND_RESOLVED', adminActor, {
          refundId: refund.id,
          resolution: refund.status,
          developerId: refund.developerId,
          adminNotes: body.adminNotes,
        });

        res.json({ data: refund });
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
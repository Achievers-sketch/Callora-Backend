import { Router } from 'express';
import { z } from 'zod';
import { getClientIp } from '../../../lib/clientIp.js';
import { successEnvelope, getRequestId } from '../../../lib/envelope.js';
import { logger } from '../../../logger.js';
import { validate } from '../../../middleware/validate.js';
import { bulkUpdateQuotaRequests } from '../../../services/quotaService.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const bulkUpdateBodySchema = z.object({
  operations: z
    .array(
      z.object({
        request_id: z.string().trim().min(1),
        action: z.enum(['approve', 'reject']),
        admin_notes: z.string().trim().optional(),
      }),
    )
    .min(1)
    .max(100),
}).strict();

type BulkUpdateBody = z.infer<typeof bulkUpdateBodySchema>;

export interface AdminQuotaBulkRouterDeps {
  updateOverrides?: (developerUserId: string, overrides: Record<string, unknown>) => Promise<void>;
}

export function createAdminQuotaBulkRouter(deps: AdminQuotaBulkRouterDeps = {}): Router {
  const router = Router();
  const { updateOverrides } = deps;

  router.post('/bulk-update', validate({ body: bulkUpdateBodySchema }), async (req, res, next) => {
    try {
      const { operations } = req.body as BulkUpdateBody;

      const mappedOps = operations.map((op) => ({
        requestId: op.request_id,
        action: op.action as 'approve' | 'reject',
        adminNotes: op.admin_notes,
      }));

      const result = await bulkUpdateQuotaRequests(mappedOps, res.locals.adminActor, updateOverrides);

      logger.audit('BULK_QUOTA_UPDATE', res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
        total: result.summary.total,
        succeeded: result.summary.succeeded,
        failed: result.summary.failed,
      });

      res.status(200).json(successEnvelope(result, getRequestId(req)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createAdminQuotaBulkRouter;

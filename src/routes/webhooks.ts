import { Router } from 'express';
import webhookRoutes from '../webhooks/webhook.routes.js';
import { securityHeadersMiddleware } from '../middleware/securityHeaders.js';

const router = Router();

// Apply security header sweep middleware to all webhook endpoints
router.use(securityHeadersMiddleware);
router.use(webhookRoutes);

export default router;
export { router as webhooksRouter };

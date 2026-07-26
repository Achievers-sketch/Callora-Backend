import { Router } from 'express';
import { timeoutMiddleware } from '../middleware/timeout.js';

export function createSpikeRouter(): Router {
  const router = Router();

  // Apply timeout middleware with a default 1000ms limit
  router.get('/', timeoutMiddleware({ timeoutMs: 1000 }), async (req, res, next) => {
    try {
      // Determine the duration of the simulated task (defaults to 2000ms)
      let delay = 2000;
      if (typeof req.query.delay === 'string') {
        const parsed = parseInt(req.query.delay, 10);
        if (!isNaN(parsed) && parsed > 0) {
          delay = parsed;
        }
      }

      const sleepInterval = 50; // Check status every 50ms
      let elapsed = 0;

      while (elapsed < delay) {
        // Cooperative Abort Check: Check if the request has been aborted/timed out
        if (req.signal?.aborted) {
          // Exit early cooperatively. Do not try to write to res or call next()
          // because the timeout middleware has already sent the 504 response.
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, sleepInterval));
        elapsed += sleepInterval;
      }

      // If completed successfully without timeout, send 200 response
      res.json({
        success: true,
        message: 'Spike completed successfully',
        delay,
        elapsed,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

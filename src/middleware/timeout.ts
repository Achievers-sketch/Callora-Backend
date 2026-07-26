import { type Request, type Response, type NextFunction } from 'express';
import { GatewayTimeoutError } from '../errors/index.js';

export interface TimeoutOptions {
  timeoutMs: number;
}

/**
 * Middleware that applies a per-request timeout.
 * Attaches a standard AbortSignal to `req.signal` for cooperative abort logic.
 */
export function timeoutMiddleware(options: TimeoutOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Determine timeout duration (default to options.timeoutMs)
    let timeoutMs = options.timeoutMs;

    // Check query parameter override
    if (typeof req.query.timeout === 'string') {
      const parsed = parseInt(req.query.timeout, 10);
      if (!isNaN(parsed) && parsed > 0) {
        timeoutMs = parsed;
      }
    }

    // Check header override
    const headerTimeout = req.header('x-timeout-ms');
    if (headerTimeout) {
      const parsed = parseInt(headerTimeout, 10);
      if (!isNaN(parsed) && parsed > 0) {
        timeoutMs = parsed;
      }
    }

    // 2. Set up AbortController for cooperative abort
    const controller = new AbortController();
    req.signal = controller.signal;

    // 3. Set timeout timer
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        controller.abort();
        next(new GatewayTimeoutError('Request timeout exceeded'));
      }
    }, timeoutMs);

    // 4. Register cleanup event listeners
    res.on('finish', () => {
      clearTimeout(timer);
    });

    res.on('close', () => {
      clearTimeout(timer);
      // If the client disconnects or connection drops, trigger cooperative abort
      if (!res.headersSent) {
        controller.abort();
      }
    });

    next();
  };
}

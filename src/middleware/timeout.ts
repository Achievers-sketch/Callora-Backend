import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

export interface TimeoutMiddlewareOptions {
  timeoutMs: number;
}

export function createTimeoutMiddleware(
  options: TimeoutMiddlewareOptions
): (req: Request, res: Response, next: NextFunction) => void {
  const { timeoutMs } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const controller = new AbortController();
    req.abortSignal = controller.signal;

    const timer = setTimeout(() => {
      controller.abort();

      if (!res.headersSent) {
        const requestId = (req as Request & { id?: string }).id ?? 'unknown';

        logger.warn('[timeout] request timed out', {
          requestId,
          method: req.method,
          path: req.path,
          timeoutMs,
        });

        res.status(504).json({
          code: 'GATEWAY_TIMEOUT',
          message: `Request timed out after ${timeoutMs}ms`,
          requestId,
        });
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      res.removeListener('finish', cleanup);
      res.removeListener('close', cleanup);
    };

    res.on('finish', cleanup);
    res.on('close', cleanup);

    next();
  };
}

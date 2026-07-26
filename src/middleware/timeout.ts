import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../logger.js';

declare global {
  namespace Express {
    interface Request {
      signal?: AbortSignal;
    }
  }
}

export interface TimeoutOptions {
  durationMs: number;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MESSAGE = 'Request timed out';

export function createTimeoutMiddleware(
  options: TimeoutOptions = { durationMs: DEFAULT_TIMEOUT_MS },
): RequestHandler {
  const durationMs = options.durationMs > 0 ? options.durationMs : DEFAULT_TIMEOUT_MS;
  const message = options.message ?? DEFAULT_MESSAGE;

  return (req: Request, res: Response, next: NextFunction): void => {
    const controller = new AbortController();
    req.signal = controller.signal;

    const timer = setTimeout(() => {
      if (res.writableEnded || res.destroyed) {
        return;
      }

      controller.abort();

      const requestId: string = (req as Request & { id?: string }).id ?? 'unknown';

      logger.warn('[timeout] request timed out', {
        requestId,
        method: req.method,
        path: req.path,
        durationMs,
      });

      res.status(504).json({
        success: false,
        error: {
          code: 'GATEWAY_TIMEOUT',
          message,
        },
        requestId,
        timestamp: new Date().toISOString(),
      });
    }, durationMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      res.removeListener('finish', cleanup);
      res.removeListener('close', cleanup);
      res.removeListener('error', cleanup);
    };

    res.once('finish', cleanup);
    res.once('close', cleanup);
    res.once('error', cleanup);

    next();
  };
}

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

export interface CorsAllowlistOptions {
  allowedOrigins: string[];
  allowCredentials?: boolean;
  maxAgeSeconds?: number;
}

const DEFAULT_MAX_AGE = 600;
const CORS_ERROR_CODE = 'ORIGIN_NOT_ALLOWED';

function parseOriginHeader(req: Request): string | undefined {
  const origin = req.header('Origin');
  if (!origin || typeof origin !== 'string') return undefined;
  return origin.trim();
}

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes(origin);
}

function sendCorsDenied(res: Response, origin: string, requestId: string): void {
  res.status(403).json({
    success: false,
    error: {
      code: CORS_ERROR_CODE,
      message: `Origin "${origin}" is not allowed`,
    },
    requestId,
    timestamp: new Date().toISOString(),
  });
}

function setCorsHeaders(res: Response, origin: string, options: CorsAllowlistOptions): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  if (options.allowCredentials) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
}

function handlePreflight(res: Response, origin: string, options: CorsAllowlistOptions): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-api-key, x-request-id');
  res.setHeader('Access-Control-Max-Age', String(options.maxAgeSeconds ?? DEFAULT_MAX_AGE));
  if (options.allowCredentials) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.status(204).end();
}

export function createCorsAllowlistMiddleware(
  options: CorsAllowlistOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const { allowedOrigins } = options;

  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    logger.warn('[cors] allowlist is empty — all origins will be denied');
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = parseOriginHeader(req);

    if (!origin) {
      logger.warn('[cors] missing Origin header', {
        method: req.method,
        path: req.path,
      });
      res.status(403).json({
        success: false,
        error: {
          code: CORS_ERROR_CODE,
          message: 'Origin header is required',
        },
        requestId: (req as Request & { id?: string }).id ?? 'unknown',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!isOriginAllowed(origin, allowedOrigins)) {
      const requestId = (req as Request & { id?: string }).id ?? 'unknown';
      logger.warn('[cors] origin not allowed', {
        origin,
        method: req.method,
        path: req.path,
        requestId,
      });
      sendCorsDenied(res, origin, requestId);
      return;
    }

    setCorsHeaders(res, origin, options);

    if (req.method === 'OPTIONS') {
      handlePreflight(res, origin, options);
      return;
    }

    next();
  };
}

export function createMaintenanceCorsMiddleware() {
  let middleware: ReturnType<typeof createCorsAllowlistMiddleware> | null = null;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!middleware) {
      const rawOrigins = process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS ?? '';
      const allowedOrigins = rawOrigins
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0);

      middleware = createCorsAllowlistMiddleware({
        allowedOrigins,
        allowCredentials: true,
        maxAgeSeconds: 600,
      });
    }
    middleware(req, res, next);
  };
}

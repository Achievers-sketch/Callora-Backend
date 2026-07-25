/**
 * Route-specific CORS allowlist middleware.
 *
 * Enforces CORS from CORS_ALLOWED_ORIGINS environment variable on a
 * per-route basis. Denies by default and caches preflight responses.
 * Designed to be more restrictive than the global app-level CORS.
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * Creates a CORS middleware that enforces an origin allowlist from the
 * CORS_ALLOWED_ORIGINS environment variable.
 *
 * Behavior:
 * - Requests with no Origin header (server-to-server, curl) are allowed.
 * - Origins matching the allowlist are allowed and receive appropriate
 *   Access-Control-* response headers.
 * - All other origins are denied with a 403 Forbidden response.
 * - Preflight (OPTIONS) requests are cached for the configured maxAge.
 *
 * The allowed origins Set is cached at construction time since the env var
 * does not change at runtime.
 *
 * @param maxAge - Cache duration in seconds for preflight responses.
 *                 Default: 600 (10 minutes, production-safe default).
 */
export function createCorsAllowlistMiddleware(maxAge: number = 600) {
  const isProduction = process.env.NODE_ENV === 'production';

  // Cache the allowlist Set at construction time — env vars don't change at runtime.
  const raw = (process.env.CORS_ALLOWED_ORIGINS ?? '').trim();
  const allowedOrigins: Set<string> = raw
    ? new Set(
        raw
          .split(',')
          .map((o) => o.trim())
          .filter((o) => o.length > 0),
      )
    : new Set();

  return function corsAllowlistMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const origin = req.get('Origin');

    // Allow requests with no origin (server-to-server, curl, mobile apps)
    if (!origin) {
      next();
      return;
    }

    // Development: also allow localhost origins
    const localhostRegex = /^http:\/\/localhost(:\d+)?$/;
    const isLocalhost = localhostRegex.test(origin);

    if (allowedOrigins.has(origin) || (!isProduction && isLocalhost)) {
      // Set CORS headers for allowed origins
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PATCH, DELETE, OPTIONS',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-admin-api-key, x-user-id, x-request-id, Idempotency-Key',
      );
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Max-Age', String(maxAge));

      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }

      next();
      return;
    }

    // Log blocked origins in production
    if (isProduction) {
      console.warn(`Route-level CORS blocked origin: ${origin} for ${req.method} ${req.path}`);
    }

    // Deny by default
    res.status(403).json({
      code: 'CORS_BLOCKED',
      message: 'Origin not allowed by CORS policy',
    });
    return;
  };
}

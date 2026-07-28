import type { Request, Response, NextFunction } from 'express';
import { getRequestId } from '../lib/envelope.js';
import { logger } from '../logger.js';

/**
 * Options for configuring security headers middleware.
 */
export interface SecurityHeadersOptions {
  /**
   * Value for Content-Security-Policy header.
   * Defaults to `"default-src 'self'; frame-ancestors 'none'; object-src 'none'"`.
   */
  contentSecurityPolicy?: string;
  /**
   * Value for X-Content-Type-Options header.
   * Defaults to `"nosniff"`.
   */
  contentTypeOptions?: string;
  /**
   * Value for Referrer-Policy header.
   * Defaults to `"strict-origin-when-cross-origin"`.
   */
  referrerPolicy?: string;
}

const DEFAULT_CSP = "default-src 'self'; frame-ancestors 'none'; object-src 'none'";
const DEFAULT_CONTENT_TYPE_OPTIONS = 'nosniff';
const DEFAULT_REFERRER_POLICY = 'strict-origin-when-cross-origin';

/**
 * Creates security header middleware enforcing CSP, X-Content-Type-Options,
 * and Referrer-Policy on all HTTP responses.
 *
 * Ensures security headers are applied to both successful responses and
 * error responses emitted downstream.
 *
 * @param options Optional custom security header values
 * @returns Express middleware function
 */
export function createSecurityHeadersMiddleware(
  options: SecurityHeadersOptions = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const csp = options.contentSecurityPolicy ?? DEFAULT_CSP;
  const contentTypeOptions = options.contentTypeOptions ?? DEFAULT_CONTENT_TYPE_OPTIONS;
  const referrerPolicy = options.referrerPolicy ?? DEFAULT_REFERRER_POLICY;

  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', contentTypeOptions);
    res.setHeader('Referrer-Policy', referrerPolicy);

    const requestId = getRequestId(req as Request & { headers: Record<string, string | string[] | undefined> });
    logger.info('[security-headers] applied headers to response', {
      requestId,
      path: req.path,
      method: req.method,
    });

    next();
  };
}

/**
 * Standard security header middleware instance with default policy headers.
 */
export const securityHeadersMiddleware = createSecurityHeadersMiddleware();

import type { Request, Response, NextFunction } from 'express';

export const AUDIT_CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
].join('; ');

export const AUDIT_X_CONTENT_TYPE_OPTIONS = 'nosniff';
export const AUDIT_REFERRER_POLICY = 'strict-origin-when-cross-origin';

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', AUDIT_CSP_POLICY);
  res.setHeader('X-Content-Type-Options', AUDIT_X_CONTENT_TYPE_OPTIONS);
  res.setHeader('Referrer-Policy', AUDIT_REFERRER_POLICY);
  next();
}

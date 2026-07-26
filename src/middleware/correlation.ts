import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { sanitizeRequestId, REQUEST_ID_MAX_LENGTH } from './requestId.js';
import { getCorrelationId, setCorrelationId } from '../utils/asyncContext.js';

const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Maximum byte length accepted for a client-supplied X-Correlation-Id value.
 */
export const CORRELATION_ID_MAX_LENGTH = REQUEST_ID_MAX_LENGTH;

/**
 * Sanitise a raw X-Correlation-Id header value.
 * Reuses the same sanitisation logic as X-Request-Id.
 */
export const sanitizeCorrelationId = sanitizeRequestId;

/**
 * Global middleware that propagates X-Correlation-Id across every request.
 * - Reads an incoming x-correlation-id header (sanitised) or generates a fresh UUID v4.
 * - Sets the X-Correlation-Id response header so clients always get a correlation token.
 * - Populates req.correlationId for downstream middleware and error handlers.
 * - Stores the correlationId in the existing AsyncLocalStorage context so it is
 *   available everywhere without passing it through arguments.
 */
export const correlationMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const raw = req.header(CORRELATION_ID_HEADER);
  const correlationId = sanitizeCorrelationId(raw) ?? uuidv4();

  (req as Request & { correlationId?: string }).correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);

  // Also store in async context so downstream services can retrieve it
  // via getCorrelationId() without plumbing through function arguments.
  setCorrelationId(correlationId);

  next();
};

export { getCorrelationId };

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { getRequestId } from '../utils/asyncContext.js';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const CORRELATION_ID_MAX_LENGTH = 256;

export const sanitizeCorrelationId = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const sanitized = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!sanitized.length || sanitized.length > CORRELATION_ID_MAX_LENGTH) return undefined;
  return sanitized;
};

export const getCorrelationId = (): string | undefined => getRequestId();

export const correlationMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const raw = req.header(CORRELATION_ID_HEADER);
  const correlationId = sanitizeCorrelationId(raw) ?? req.id ?? randomUUID();

  req.correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);

  next();
};

export interface OutboundHeaders {
  'X-Correlation-Id': string;
  'X-Request-Id'?: string;
}

export const buildOutboundCorrelationHeaders = (): OutboundHeaders => {
  const correlationId = getCorrelationId();
  return {
    'X-Correlation-Id': correlationId ?? randomUUID(),
    ...(correlationId ? { 'X-Request-Id': correlationId } : {}),
  };
};

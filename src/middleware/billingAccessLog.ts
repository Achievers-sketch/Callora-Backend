import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClientIp } from '../lib/clientIp.js';
import { getRequestId } from '../utils/asyncContext.js';
import { logger } from './logging.js';
import { sanitizeRequestId } from './requestId.js';

export const BILLING_LOG_REDACTED_VALUE = '[REDACTED]';

export const billingLogger = logger.child({ channel: 'billing' });

export interface BillingAccessLogPayload {
  correlationId: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  statusCode: number;
  ms: number;
  durationMs: number;
  userId?: string;
  clientIp?: string;
  apiId?: string;
  endpointId?: string;
  apiKeyId?: string;
  amountUsdc?: string;
  billingRequestId?: string;
}

export interface BillingAccessLogOptions {
  redactFields?: readonly string[];
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

function extractBillingPayload(req: Request): Partial<BillingAccessLogPayload> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return {};

  const payload: Partial<BillingAccessLogPayload> = {};
  if (typeof body.apiId === 'string') payload.apiId = body.apiId;
  if (typeof body.endpointId === 'string') payload.endpointId = body.endpointId;
  if (typeof body.apiKeyId === 'string') payload.apiKeyId = body.apiKeyId;
  if (typeof body.amountUsdc === 'string') payload.amountUsdc = body.amountUsdc;
  if (typeof body.requestId === 'string') payload.billingRequestId = body.requestId;
  return payload;
}

function extractUser(res: Response): string | undefined {
  const locals = res.locals as Record<string, unknown>;
  const user = locals.authenticatedUser as { id?: string } | undefined;
  return user?.id;
}

export function createBillingAccessLogMiddleware(options: BillingAccessLogOptions = {}) {
  const redactFields = options.redactFields?.map((f) => f.toLowerCase()) ?? [];
  const billingLoggerInstance = options.logger ?? billingLogger;

  return function billingAccessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startAt = process.hrtime.bigint();
    const requestId =
      sanitizeRequestId(req.id) ??
      getRequestId() ??
      sanitizeRequestId(
        Array.isArray(req.headers['x-request-id'])
          ? req.headers['x-request-id'][0]
          : req.headers['x-request-id'],
      ) ??
      uuidv4();

    const clientIp = getClientIp(req, TRUST_PROXY);

    const emitLog = (): void => {
      const elapsedMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;
      const status = res.statusCode;
      const userId = extractUser(res);
      const billingContext = extractBillingPayload(req);

      const payload: BillingAccessLogPayload = {
        correlationId: requestId,
        requestId,
        method: req.method,
        path: req.path,
        status,
        statusCode: status,
        ms: Number(elapsedMs.toFixed(3)),
        durationMs: Number(elapsedMs.toFixed(3)),
        ...(userId ? { userId } : {}),
        ...(clientIp ? { clientIp } : {}),
        ...billingContext,
      };

      if (redactFields.length > 0) {
        const lowerKeyToActual = Object.keys(payload).reduce<Record<string, string>>(
          (map, key) => {
            map[key.toLowerCase()] = key;
            return map;
          },
          {},
        );
        for (const field of redactFields) {
          const actualKey = lowerKeyToActual[field];
          if (actualKey) {
            (payload as unknown as Record<string, string>)[actualKey] = BILLING_LOG_REDACTED_VALUE;
          }
        }
      }

      if (status >= 500) {
        billingLoggerInstance.error({ ...payload }, 'billing request completed');
      } else if (status >= 400) {
        billingLoggerInstance.warn({ ...payload }, 'billing request completed');
      } else {
        billingLoggerInstance.info({ ...payload }, 'billing request completed');
      }
    };

    res.once('finish', emitLog);
    res.once('close', () => {
      if (!res.writableEnded) {
        emitLog();
      }
    });

    next();
  };
}

export const billingAccessLogMiddleware = createBillingAccessLogMiddleware();

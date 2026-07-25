import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getClientIp } from '../lib/clientIp.js';
import { logger } from '../logger.js';
import { resolveRequestUserId } from './requireAuth.js';
import { errorEnvelope } from '../lib/envelope.js';
import { getRequestId } from '../lib/envelope.js';

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
}

function computeTokenBucketResult(
  bucket: TokenBucket | undefined,
  maxRequests: number,
  windowMs: number,
  now: number,
): { bucket: TokenBucket; result: RateLimitCheckResult } {
  const currentBucket = bucket
    ? { ...bucket }
    : { tokens: maxRequests, lastRefill: now };

  const elapsed = now - currentBucket.lastRefill;

  if (elapsed >= windowMs) {
    currentBucket.tokens = maxRequests;
    currentBucket.lastRefill = now;
  }

  if (currentBucket.tokens <= 0) {
    const retryAfterMs = Math.max(
      windowMs - (now - currentBucket.lastRefill),
      0,
    );

    return {
      bucket: currentBucket,
      result: { allowed: false, retryAfterMs },
    };
  }

  currentBucket.tokens -= 1;

  return {
    bucket: currentBucket,
    result: { allowed: true },
  };
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitCheckResult {
    const existingBucket = this.buckets.get(key);
    const { bucket, result } = computeTokenBucketResult(
      existingBucket,
      this.maxRequests,
      this.windowMs,
      now,
    );

    this.buckets.set(key, bucket);
    return result;
  }

  reset(): void {
    this.buckets.clear();
  }
}

export function getRateLimitKey(req: Request): string {
  const { userId } = resolveRequestUserId(req);
  if (userId) {
    return `user:${userId}`;
  }

  const clientIp = getClientIp(req);
  return `ip:${clientIp}`;
}

export function createRateLimitMiddleware(
  options: RateLimitOptions,
  limiter = new InMemoryRateLimiter(options.windowMs, options.maxRequests),
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = getRateLimitKey(req);
    const result = limiter.check(key);

    if (!result.allowed) {
      const retryAfterMs = result.retryAfterMs ?? options.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      const requestId = getRequestId(req);

      logger.warn('[rateLimit] request limit exceeded', {
        requestId,
        key,
        retryAfterMs,
      });

      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json(errorEnvelope(
        'TOO_MANY_REQUESTS',
        'Too Many Requests',
        requestId,
        { retryAfterMs },
      ));
      return;
    }

    next();
  };
}

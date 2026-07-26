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

// ─── Token Bucket Rate Limiter ───────────────────────────────────────────────

export interface TokenBucketOptions {
  capacity: number;
  refillRate: number;
}

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, TokenBucketState>();

  constructor(
    private readonly capacity: number,
    private readonly refillRate: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitCheckResult {
    const bucket = this.buckets.get(key);

    if (!bucket) {
      this.buckets.set(key, {
        tokens: this.capacity - 1,
        lastRefill: now,
      });
      return { allowed: true };
    }

    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs > 0) {
      const tokensToAdd = (elapsedMs / 1000) * this.refillRate;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    const retryAfterMs = Math.ceil((1000 / this.refillRate) * (1 - bucket.tokens));
    return { allowed: false, retryAfterMs };
  }

  reset(): void {
    this.buckets.clear();
  }
}

export function createTokenBucketRateLimitMiddleware(
  options: TokenBucketOptions,
  limiter = new TokenBucketRateLimiter(options.capacity, options.refillRate),
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = getRateLimitKey(req);
    const result = limiter.check(key);

    if (!result.allowed) {
      const retryAfterMs = result.retryAfterMs ?? 1000;
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      const requestId: string = (req as Request & { id?: string }).id ?? 'unknown';

      logger.warn('[tokenBucketRateLimit] request limit exceeded', {
        requestId,
        key,
        retryAfterMs,
      });

      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too Many Requests',
        requestId,
        retryAfterMs,
      });
      return;
    }

    next();
  };
}

export function createCreditsRateLimitMiddleware(
  options?: TokenBucketOptions,
): RequestHandler {
  const opts: TokenBucketOptions = options ?? { capacity: 10, refillRate: 1 };
  return createTokenBucketRateLimitMiddleware(opts);
}

// ─── Fixed-Window Rate Limiter ───────────────────────────────────────────────

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

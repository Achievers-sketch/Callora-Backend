import express from 'express';
import request from 'supertest';
import { errorHandler } from './errorHandler.js';
import { createRateLimitMiddleware, InMemoryRateLimiter } from './rateLimit.js';
import { requireAuth, type AuthenticatedLocals } from './requireAuth.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';

function buildProtectedApp(windowMs = 60_000, maxRequests = 2) {
  const app = express();
  const rateLimit = createRateLimitMiddleware({
    windowMs,
    maxRequests,
  });

  app.get(
    '/protected',
    rateLimit,
    requireAuth,
    (_req, res: express.Response<unknown, AuthenticatedLocals>) => {
      res.json({ ok: true, userId: res.locals.authenticatedUser?.id });
    },
  );

  app.use(errorHandler);
  return app;
}

describe('rateLimit middleware (token-bucket)', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.JWT_SECRET = originalSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  it('returns 429 after the per-user limit is exceeded with canonical error envelope', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    const response = await request(app).get('/protected').set('x-user-id', 'user-1');

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(response.body.error.message).toBe('Too Many Requests');
    expect(response.body.error.details.retryAfterMs).toBeGreaterThan(0);
    expect(response.body.requestId).toBeDefined();
    expect(response.body.timestamp).toBeDefined();
  });

  it('tracks requests separately for different users', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-2').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-2').expect(200);

    await request(app).get('/protected').set('x-user-id', 'user-1').expect(429);
    await request(app).get('/protected').set('x-user-id', 'user-2').expect(429);
  });

  it('uses the authenticated user id when a bearer token is present', async () => {
    const app = buildProtectedApp();
    const token = signTestToken({ userId: 'user-1', walletAddress: 'GDTEST123STELLAR' });

    await request(app).get('/protected').set('Authorization', `Bearer ${token}`).expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('refills tokens after window elapses', async () => {
    const windowMs = 100;
    const limiter = new InMemoryRateLimiter(windowMs, 2);

    limiter.check('key', 0);
    limiter.check('key', 0);
    const blocked = limiter.check('key', 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(windowMs);

    const afterWindow = limiter.check('key', windowMs + 1);
    expect(afterWindow.allowed).toBe(true);
  });

  it('returns 429 with Retry-After header and structured details', async () => {
    const app = buildProtectedApp(1000, 1);

    await request(app).get('/protected').set('x-user-id', 'user-x').expect(200);
    const response = await request(app).get('/protected').set('x-user-id', 'user-x');

    expect(response.status).toBe(429);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(typeof response.body.error.details.retryAfterMs).toBe('number');
    expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('falls back to IP-based keying when no user id is provided', async () => {
    const app = express();
    const rateLimit = createRateLimitMiddleware({
      windowMs: 60_000,
      maxRequests: 1,
    });
    app.get('/public', rateLimit, (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    await request(app).get('/public').expect(200);
    const response = await request(app).get('/public');

    expect(response.status).toBe(429);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('TOO_MANY_REQUESTS');
  });
});

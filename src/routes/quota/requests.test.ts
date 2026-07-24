/**
 * Tests for the quota self-service router.
 *
 * Covers:
 *   POST   /api/quota/requests         - submit a new request
 *   GET    /api/quota/requests         - list caller own requests
 *   GET    /api/quota/requests/:id     - fetch a single request by ID
 *
 * Edge cases:
 *   - Missing / invalid auth
 *   - Zod validation failures (missing fields, bad enum, reason too short/long)
 *   - Invalid status query param
 *   - Cross-user ownership guard (GET /:id returns 404 for other user request)
 *   - Status filter for list endpoint
 *   - Store isolation via setQuotaRequestStore in beforeEach
 */

import request from 'supertest';
import express from 'express';
import quotaRequestsRouter from './requests.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import {
  setQuotaRequestStore,
  getQuotaRequestStore,
  InMemoryQuotaRequestStore,
} from '../../services/quotaService.js';

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/quota/requests', quotaRequestsRouter);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Valid minimum body for POST /api/quota/requests */
const validBody = {
  requested_tier: 'pro',
  reason: 'Need higher rate limits for production workload',
};

// ---------------------------------------------------------------------------
// POST /api/quota/requests
// ---------------------------------------------------------------------------

describe('POST /api/quota/requests', () => {
  beforeEach(() => {
    setQuotaRequestStore(new InMemoryQuotaRequestStore());
  });

  it('201 - creates a pending request with required fields', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'Need higher rate limits for production workload',
      status: 'pending',
    });
    expect(typeof res.body.data.id).toBe('string');
    expect(res.body.data.createdAt).toBeDefined();
    expect(res.body.data.resolvedAt).toBeUndefined();
  });

  it('201 - creates a request with optional overrides', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({
        requested_tier: 'enterprise',
        reason: 'Running large-scale production APIs that need higher monthly limits',
        requested_overrides: {
          monthly_call_limit: 500000,
          rate_limit_max_requests: 10000,
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.requestedOverrides).toEqual({
      monthlyCallLimit: 500000,
      rateLimitMaxRequests: 10000,
    });
  });

  it('201 - accepts all valid tier values', async () => {
    const app = createTestApp();
    const tiers = ['free', 'pro', 'enterprise'] as const;

    for (const tier of tiers) {
      setQuotaRequestStore(new InMemoryQuotaRequestStore());
      const res = await request(app)
        .post('/api/quota/requests')
        .set('x-user-id', 'dev-tiers')
        .send({ requested_tier: tier, reason: 'Testing each tier value in a loop' });
      expect(res.status).toBe(201);
      expect(res.body.data.requestedTier).toBe(tier);
    }
  });

  it('201 - persists the request in the store', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-42')
      .send({ requested_tier: 'free', reason: 'Testing that the request is persisted in the store' });

    const store = getQuotaRequestStore();
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].developerId).toBe('dev-42');
  });

  it('400 VALIDATION_ERROR - missing required fields', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('400 VALIDATION_ERROR - invalid requested_tier enum', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({ requested_tier: 'ultra', reason: 'Need ultra tier for high traffic volume' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR - reason too short (< 10 chars)', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({ requested_tier: 'pro', reason: 'Short' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR - reason too long (> 1000 chars)', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({ requested_tier: 'pro', reason: 'x'.repeat(1001) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR - missing reason entirely', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({ requested_tier: 'pro' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR - missing requested_tier entirely', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({ reason: 'Need higher rate limits for production workload' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('401 - no authentication provided', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/quota/requests')
      .send(validBody);

    expect(res.status).toBe(401);
  });

  it('returns X-Request-Id header in response', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'test-req-id-123')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.headers['x-request-id']).toBe('test-req-id-123');
  });
});

// ---------------------------------------------------------------------------
// GET /api/quota/requests
// ---------------------------------------------------------------------------

describe('GET /api/quota/requests', () => {
  beforeEach(() => {
    setQuotaRequestStore(new InMemoryQuotaRequestStore());
  });

  it('200 - returns empty array when no requests exist', async () => {
    const app = createTestApp();

    const res = await request(app)
      .get('/api/quota/requests')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('200 - returns only the callers own requests', async () => {
    const app = createTestApp();

    // Create requests for two different developers
    await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-2')
      .send({ requested_tier: 'enterprise', reason: 'Other developer request reason here' });

    const res = await request(app)
      .get('/api/quota/requests')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].developerId).toBe('dev-1');
  });

  it('200 - returns multiple requests for the same developer', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({ requested_tier: 'enterprise', reason: 'Second request for enterprise tier upgrade' });

    const res = await request(app)
      .get('/api/quota/requests')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    res.body.data.forEach((r: { developerId: string }) => {
      expect(r.developerId).toBe('dev-1');
    });
  });

  it('200 - filters by ?status=pending', async () => {
    const store = getQuotaRequestStore();
    // Seed one pending and one approved request for dev-1
    const r1 = await store.create({
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'Pending request that stays in pending state',
    });
    const r2 = await store.create({
      developerId: 'dev-1',
      requestedTier: 'enterprise',
      reason: 'Approved request that gets resolved by admin',
    });
    await store.update(r2.id, { status: 'approved', resolvedBy: 'admin-1', resolvedAt: new Date() });

    const app = createTestApp();
    const res = await request(app)
      .get('/api/quota/requests?status=pending')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(r1.id);
    expect(res.body.data[0].status).toBe('pending');
  });

  it('200 - filters by ?status=approved', async () => {
    const store = getQuotaRequestStore();
    const r1 = await store.create({
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'Will remain pending through this test',
    });
    const r2 = await store.create({
      developerId: 'dev-1',
      requestedTier: 'enterprise',
      reason: 'Will be marked approved for filter test',
    });
    await store.update(r1.id, { status: 'approved' });
    await store.update(r2.id, { status: 'rejected' });

    const app = createTestApp();
    const res = await request(app)
      .get('/api/quota/requests?status=approved')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('approved');
  });

  it('200 - filters by ?status=rejected', async () => {
    const store = getQuotaRequestStore();
    await store.create({
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'Will stay pending for rejected filter test',
    });
    const r2 = await store.create({
      developerId: 'dev-1',
      requestedTier: 'enterprise',
      reason: 'Will be marked rejected for filter test here',
    });
    await store.update(r2.id, { status: 'rejected' });

    const app = createTestApp();
    const res = await request(app)
      .get('/api/quota/requests?status=rejected')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(r2.id);
  });

  it('400 VALIDATION_ERROR - invalid status query param', async () => {
    const app = createTestApp();

    const res = await request(app)
      .get('/api/quota/requests?status=invalid')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('401 - no authentication provided (list)', async () => {
    const app = createTestApp();

    const res = await request(app).get('/api/quota/requests');

    expect(res.status).toBe(401);
  });

  it('200 - does not return other developers requests without status filter', async () => {
    const store = getQuotaRequestStore();
    await store.create({ developerId: 'dev-other', requestedTier: 'pro', reason: 'Another dev request' });

    const app = createTestApp();
    const res = await request(app)
      .get('/api/quota/requests')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/quota/requests/:id
// ---------------------------------------------------------------------------

describe('GET /api/quota/requests/:id', () => {
  beforeEach(() => {
    setQuotaRequestStore(new InMemoryQuotaRequestStore());
  });

  it('200 - returns the callers own request by ID', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    const id = created.body.data.id;

    const res = await request(app)
      .get(`/api/quota/requests/${id}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.developerId).toBe('dev-1');
    expect(res.body.data.requestedTier).toBe('pro');
    expect(res.body.data.status).toBe('pending');
  });

  it('200 - response includes all expected fields', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-1')
      .send({
        requested_tier: 'enterprise',
        reason: 'Running large-scale production APIs needing higher limits',
        requested_overrides: {
          monthly_call_limit: 200000,
          rate_limit_max_requests: 5000,
        },
      });

    const id = created.body.data.id;
    const res = await request(app)
      .get(`/api/quota/requests/${id}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id,
      developerId: 'dev-1',
      requestedTier: 'enterprise',
      status: 'pending',
      requestedOverrides: {
        monthlyCallLimit: 200000,
        rateLimitMaxRequests: 5000,
      },
    });
    expect(res.body.data.createdAt).toBeDefined();
  });

  it('404 QUOTA_REQUEST_NOT_FOUND - nonexistent ID', async () => {
    const app = createTestApp();

    const res = await request(app)
      .get('/api/quota/requests/nonexistent-id')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTA_REQUEST_NOT_FOUND');
  });

  it('404 QUOTA_REQUEST_NOT_FOUND - ID belongs to different developer (ownership guard)', async () => {
    const app = createTestApp();

    // dev-2 creates a request
    const created = await request(app)
      .post('/api/quota/requests')
      .set('x-user-id', 'dev-2')
      .send(validBody);

    const id = created.body.data.id;

    // dev-1 tries to fetch dev-2 request - should get 404, not 403
    const res = await request(app)
      .get(`/api/quota/requests/${id}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTA_REQUEST_NOT_FOUND');
  });

  it('401 - no authentication provided (get by id)', async () => {
    const app = createTestApp();

    const res = await request(app).get('/api/quota/requests/some-id');

    expect(res.status).toBe(401);
  });

  it('200 - caller can access their own approved request', async () => {
    const store = getQuotaRequestStore();
    const created = await store.create({
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'Request that will be approved by admin',
    });
    await store.update(created.id, {
      status: 'approved',
      resolvedBy: 'admin-1',
      resolvedAt: new Date(),
      adminNotes: 'Approved after review',
    });

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/quota/requests/${created.id}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.adminNotes).toBe('Approved after review');
    expect(res.body.data.resolvedBy).toBe('admin-1');
  });

  it('200 - caller can access their own rejected request', async () => {
    const store = getQuotaRequestStore();
    const created = await store.create({
      developerId: 'dev-1',
      requestedTier: 'enterprise',
      reason: 'Request that will be rejected by admin',
    });
    await store.update(created.id, {
      status: 'rejected',
      resolvedBy: 'admin-1',
      resolvedAt: new Date(),
      adminNotes: 'Insufficient justification provided',
    });

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/quota/requests/${created.id}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.adminNotes).toBe('Insufficient justification provided');
  });
});

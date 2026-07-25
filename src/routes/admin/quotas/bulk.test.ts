import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { setQuotaRequestStore, createQuotaRequest, type QuotaRequestStore, InMemoryQuotaRequestStore } from '../../../services/quotaService.js';
import { createAdminQuotaBulkRouter } from './bulk.js';

const ADMIN_KEY = 'test-admin-key';
const noopUpdateOverrides = async () => {};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.adminActor = 'admin-test';
    next();
  });
  app.use('/api/admin/quota/requests', createAdminQuotaBulkRouter({ updateOverrides: noopUpdateOverrides }));
  app.use(errorHandler);
  return app;
}

describe('POST /api/admin/quota/requests/bulk-update', () => {
  let store: QuotaRequestStore;

  beforeEach(() => {
    store = new InMemoryQuotaRequestStore();
    setQuotaRequestStore(store);
  });

  it('approves multiple requests', async () => {
    const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'test' });
    const r2 = await createQuotaRequest({ developerId: 'dev-2', requestedTier: 'enterprise', reason: 'test' });

    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/quota/requests/bulk-update')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({
        operations: [
          { request_id: r1.id, action: 'approve', admin_notes: 'Approved' },
          { request_id: r2.id, action: 'approve' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(res.body.data.results).toHaveLength(2);
  });

  it('rejects multiple requests', async () => {
    const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'test' });
    const r2 = await createQuotaRequest({ developerId: 'dev-2', requestedTier: 'free', reason: 'test' });

    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/quota/requests/bulk-update')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({
        operations: [
          { request_id: r1.id, action: 'reject' },
          { request_id: r2.id, action: 'reject', admin_notes: 'No thanks' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
  });

  it('returns 400 when any request fails validation', async () => {
    const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'test' });

    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/quota/requests/bulk-update')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({
        operations: [
          { request_id: r1.id, action: 'approve' },
          { request_id: 'nonexistent', action: 'approve' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BULK_QUOTA_UPDATE_FAILED');
    expect(res.body.error.details).toHaveLength(1);
    expect(res.body.error.details[0].requestId).toBe('nonexistent');
  });

  it('returns 400 when body operations array is empty', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/quota/requests/bulk-update')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ operations: [] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when operation has invalid action', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/quota/requests/bulk-update')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({
        operations: [{ request_id: 'some-id', action: 'destroy' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when request_id is empty', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/quota/requests/bulk-update')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({
        operations: [{ request_id: '', action: 'approve' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('requires admin authentication', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/quota/requests/bulk-update')
      .send({
        operations: [{ request_id: 'some-id', action: 'approve' }],
      });

    expect(res.status).toBe(401);
  });
});

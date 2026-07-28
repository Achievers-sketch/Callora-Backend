import express from 'express';
import request from 'supertest';
import webhookRoutes from './webhooks.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { WebhookStore } from '../webhooks/webhook.store.js';
import { logger } from '../logger.js';

var mockDnsLookup = jest.fn();
jest.mock('dns/promises', () => {
  const lookup = (...args: unknown[]) => mockDnsLookup(...args);
  return { __esModule: true, default: { lookup }, lookup };
});

function buildApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use('/api/webhooks', webhookRoutes);
  app.use(errorHandler);
  return app;
}

describe('validated /api/webhooks routes', () => {
  let app: express.Express;
  let infoSpy: jest.SpyInstance;
  let auditSpy: jest.SpyInstance;

  beforeEach(() => {
    app = buildApp();
    WebhookStore.clear();
    WebhookStore.clearDlq();
    WebhookStore.clearFailedDeliveries();
    mockDnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    auditSpy = jest.spyOn(logger, 'audit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    auditSpy.mockRestore();
  });

  it('returns structured 400 for invalid registration payloads', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .set('x-request-id', 'req-webhook-invalid')
      .send({ url: 'not-a-url', events: [] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
      },
      requestId: 'req-webhook-invalid',
    });
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body.developerId' }),
        expect.objectContaining({ field: 'body.url' }),
        expect.objectContaining({ field: 'body.events' }),
      ]),
    );
  });

  it('rejects unknown registration fields before storing anything', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .send({
        developerId: 'dev-123',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
        secret: 'super-secret',
        role: 'admin',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body', code: 'UNRECOGNIZED_KEYS' }),
      ]),
    );
    expect(WebhookStore.get('dev-123')).toBeUndefined();
  });

  it('registers a valid webhook and logs non-secret correlation metadata', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .set('x-request-id', 'req-webhook-create')
      .set('x-correlation-id', 'corr-webhook-create')
      .send({
        developerId: 'dev-123',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
        secret: 'super-secret',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      message: 'Webhook registered successfully.',
      developerId: 'dev-123',
      url: 'https://example.com/webhook',
      events: ['new_api_call'],
    });
    expect(res.body).not.toHaveProperty('secret');
    expect(infoSpy).toHaveBeenCalledWith(
      '[webhooks] webhook registered',
      expect.objectContaining({
        requestId: 'req-webhook-create',
        correlationId: 'corr-webhook-create',
        developerId: 'dev-123',
        hasSecret: true,
      }),
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain('super-secret');
  });

  it('returns structured 400 for invalid developerId params', async () => {
    const res = await request(app)
      .get('/api/webhooks/no')
      .set('x-request-id', 'req-webhook-param');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
      requestId: 'req-webhook-param',
    });
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'params.developerId' }),
      ]),
    );
  });

  it('returns structured 400 for invalid retry policy update body', async () => {
    WebhookStore.register({
      developerId: 'dev-retry',
      url: 'https://example.com/webhook',
      events: ['new_api_call'],
      createdAt: new Date(),
    });

    const res = await request(app)
      .patch('/api/webhooks/dev-retry/retry-policy')
      .set('x-request-id', 'req-webhook-retry')
      .send({ retryPolicy: { maxRetries: 11 }, extra: true });

    expect(res.status).toBe(400);
    expect(res.body.requestId).toBe('req-webhook-retry');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body.retryPolicy.maxRetries' }),
        expect.objectContaining({ field: 'body', code: 'UNRECOGNIZED_KEYS' }),
      ]),
    );
  });

  it('validates params and returns a safe webhook config without secrets', async () => {
    WebhookStore.register({
      developerId: 'dev-get',
      url: 'https://example.com/webhook',
      events: ['new_api_call'],
      secret: 'super-secret',
      createdAt: new Date(),
    });

    const res = await request(app).get('/api/webhooks/dev-get');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        developerId: 'dev-get',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
      }),
    );
    expect(res.body).not.toHaveProperty('secret');
    expect(res.body).not.toHaveProperty('secret_current');
    expect(res.body).not.toHaveProperty('secret_previous');
  });

  it('rotates secrets with correlation metadata in the audit event', async () => {
    WebhookStore.register({
      developerId: 'dev-rotate',
      url: 'https://example.com/webhook',
      events: ['new_api_call'],
      secret: 'old-secret',
      createdAt: new Date(),
    });

    const res = await request(app)
      .post('/api/webhooks/dev-rotate/rotate-secret')
      .set('x-correlation-id', 'corr-rotate');

    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(auditSpy).toHaveBeenCalledWith(
      'WEBHOOK_SECRET_ROTATED',
      'dev-rotate',
      expect.objectContaining({
        developerId: 'dev-rotate',
        correlationId: 'corr-rotate',
        hadPreviousSecret: true,
      }),
    );
  });

  it('updates retry policy and audits correlation metadata', async () => {
    WebhookStore.register({
      developerId: 'dev-retry-ok',
      url: 'https://example.com/webhook',
      events: ['new_api_call'],
      createdAt: new Date(),
    });

    const res = await request(app)
      .patch('/api/webhooks/dev-retry-ok/retry-policy')
      .set('x-correlation-id', 'corr-retry-ok')
      .send({ retryPolicy: { maxRetries: 2, baseDelayMs: 500 } });

    expect(res.status).toBe(200);
    expect(res.body.retryPolicy).toEqual({ maxRetries: 2, baseDelayMs: 500 });
    expect(auditSpy).toHaveBeenCalledWith(
      'WEBHOOK_RETRY_POLICY_UPDATED',
      'dev-retry-ok',
      expect.objectContaining({
        developerId: 'dev-retry-ok',
        correlationId: 'corr-retry-ok',
        retryPolicy: { maxRetries: 2, baseDelayMs: 500 },
      }),
    );
  });

  it('deletes webhooks with structured non-secret logs', async () => {
    WebhookStore.register({
      developerId: 'dev-delete',
      url: 'https://example.com/webhook',
      events: ['new_api_call'],
      secret: 'super-secret',
      createdAt: new Date(),
    });

    const res = await request(app)
      .delete('/api/webhooks/dev-delete')
      .set('x-request-id', 'req-delete')
      .set('x-correlation-id', 'corr-delete');

    expect(res.status).toBe(200);
    expect(WebhookStore.get('dev-delete')).toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(
      '[webhooks] webhook removed',
      expect.objectContaining({
        requestId: 'req-delete',
        correlationId: 'corr-delete',
        developerId: 'dev-delete',
      }),
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain('super-secret');
  });
});

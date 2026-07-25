import request from 'supertest';
import express from 'express';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { createExportSchedulesRouter } from './schedules.js';
import { InMemoryScheduleStore, HmacObjectStorageClient, ScheduledExportsService } from '../../services/scheduledExports.js';
import { exportsLogger } from '../../middleware/exportsAccessLog.js';

const service = new ScheduledExportsService({ findByApiId: async () => [] }, new InMemoryScheduleStore(), new HmacObjectStorageClient());

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/exports/schedules', createExportSchedulesRouter(service));
  app.use(errorHandler);
  return app;
}

test('POST /api/exports/schedules creates a schedule with redacted secret', async () => {
  const app = createTestApp();
  const response = await request(app)
    .post('/api/exports/schedules')
    .set('x-user-id', 'dev-1')
    .send({
      name: 'Nightly',
      cron: '* * * * *',
      s3Bucket: 'exports',
      s3Region: 'us-east-1',
      s3Endpoint: 'https://s3.example.com',
      s3AccessKeyId: 'akid',
      s3SecretAccessKey: 'secret',
    });

  expect(response.status).toBe(201);
  expect(response.body.data.s3SecretAccessKey).toBe('[REDACTED]');
});

test('PATCH /api/exports/schedules rejects invalid cron with standardized error envelope', async () => {
  const app = createTestApp();
  const created = await request(app)
    .post('/api/exports/schedules')
    .set('x-user-id', 'dev-1')
    .send({
      name: 'Nightly',
      cron: '* * * * *',
      s3Bucket: 'exports',
      s3Region: 'us-east-1',
      s3Endpoint: 'https://s3.example.com',
      s3AccessKeyId: 'akid',
      s3SecretAccessKey: 'secret',
    });

  const response = await request(app)
    .patch(`/api/exports/schedules/${created.body.data.id}`)
    .set('x-user-id', 'dev-1')
    .send({ cron: 'invalid' });

  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INVALID_EXPORT_SCHEDULE');
  expect(response.body.requestId).toBeDefined();
});

// ---------------------------------------------------------------------------
// Access-log integration: verify the middleware fires on real HTTP requests
// ---------------------------------------------------------------------------

describe('exports route — access log integration', () => {
  test('emits an info log entry for a successful GET /api/exports/schedules', async () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);
    const app = createTestApp();

    try {
      await request(app)
        .get('/api/exports/schedules')
        .set('x-user-id', 'dev-log-test')
        .set('x-request-id', 'route-req-1');

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          status: 200,
          statusCode: 200,
          requestId: 'route-req-1',
        }),
        'exports request completed',
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('emits a warn log entry for a 400 response (invalid PATCH body)', async () => {
    const warnSpy = jest.spyOn(exportsLogger, 'warn').mockImplementation(() => exportsLogger);
    const app = createTestApp();

    // First create a schedule so we have a real ID to PATCH.
    const createResp = await request(app)
      .post('/api/exports/schedules')
      .set('x-user-id', 'dev-log-test')
      .send({
        name: 'Log test',
        cron: '0 * * * *',
        s3Bucket: 'exports',
        s3Region: 'us-east-1',
        s3Endpoint: 'https://s3.example.com',
        s3AccessKeyId: 'akid',
        s3SecretAccessKey: 'secret',
      });

    warnSpy.mockClear();

    try {
      await request(app)
        .patch(`/api/exports/schedules/${createResp.body.data.id}`)
        .set('x-user-id', 'dev-log-test')
        .set('x-request-id', 'route-req-warn')
        .send({ cron: 'bad-cron' });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          status: 400,
          statusCode: 400,
        }),
        'exports request completed',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('emits log with scheduleId field on PATCH requests', async () => {
    const infoSpy = jest.spyOn(exportsLogger, 'info').mockImplementation(() => exportsLogger);
    const app = createTestApp();

    const createResp = await request(app)
      .post('/api/exports/schedules')
      .set('x-user-id', 'dev-sched-id')
      .send({
        name: 'Sched ID test',
        cron: '0 0 * * *',
        s3Bucket: 'exports',
        s3Region: 'us-east-1',
        s3Endpoint: 'https://s3.example.com',
        s3AccessKeyId: 'akid',
        s3SecretAccessKey: 'secret',
      });

    infoSpy.mockClear();

    try {
      await request(app)
        .patch(`/api/exports/schedules/${createResp.body.data.id}`)
        .set('x-user-id', 'dev-sched-id')
        .send({ enabled: false });

      const patchLogCall = infoSpy.mock.calls.find((call) => {
        const p = call[0] as Record<string, unknown>;
        return p.method === 'PATCH';
      });

      expect(patchLogCall).toBeDefined();
      expect(patchLogCall?.[0]).toEqual(
        expect.objectContaining({
          scheduleId: createResp.body.data.id,
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});

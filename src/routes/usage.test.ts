jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { logger } from '../middleware/logging.js';
import { createUsageRouter, type UsageRouterDeps } from './usage.js';
import type { UsageEvent, GroupBy, UsageStats, UsageBucket } from '../repositories/usageEventsRepository.js';
import type { UsageEventsPgRepository } from '../repositories/usageEventsRepository.pg.js';

function createMockRepo(overrides?: Partial<UsageRouterDeps['usageEventsRepository']>) {
  const defaultEvents: UsageEvent[] = [
    {
      id: 'evt-1',
      userId: 'user-1',
      apiId: 'api-1',
      endpoint: '/v1/weather',
      amount: 0.01,
      createdAt: new Date('2026-07-01T10:00:00Z'),
      occurredAt: new Date('2026-07-01T10:00:00Z'),
      revenue: 0.01,
    },
    {
      id: 'evt-2',
      userId: 'user-1',
      apiId: 'api-2',
      endpoint: '/v1/translate',
      amount: 0.02,
      createdAt: new Date('2026-07-02T12:00:00Z'),
      occurredAt: new Date('2026-07-02T12:00:00Z'),
      revenue: 0.02,
    },
  ];

  return {
    findByUser: jest.fn().mockResolvedValue(defaultEvents),
    aggregateByUser: jest.fn().mockResolvedValue({
      totalCalls: 2,
      totalRevenue: 0.03,
      breakdownByApi: [
        { apiId: 'api-1', calls: 1, revenue: 0.01 },
        { apiId: 'api-2', calls: 1, revenue: 0.02 },
      ],
      buckets: undefined,
    }),
    ...overrides,
  } as UsageRouterDeps['usageEventsRepository'];
}

describe('createUsageRouter', () => {
  function buildApp(repo?: UsageRouterDeps['usageEventsRepository']) {
    const app = express();
    app.use('/api/usage', createUsageRouter({ usageEventsRepository: repo ?? createMockRepo() }));
    app.use(errorHandler);
    return app;
  }

  it('returns usage events and stats for authenticated user', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/api/usage')
      .set('x-user-id', 'user-1');

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.stats).toEqual(
      expect.objectContaining({
        totalCalls: 2,
        totalSpent: '0.03',
      }),
    );
    expect(res.body.period).toBeDefined();
  });

  it('returns 401 without authentication', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/usage');

    expect(res.status).toBe(401);
  });
});

describe('Usage route ETag support', () => {
  function buildApp(repo?: UsageRouterDeps['usageEventsRepository']) {
    const app = express();
    app.use('/api/usage', createUsageRouter({ usageEventsRepository: repo ?? createMockRepo() }));
    app.use(errorHandler);
    return app;
  }

  it('sets an ETag header on GET / response', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/api/usage')
      .set('x-user-id', 'user-1');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    expect(res.headers.etag).toMatch(/^W\/"/);
  });

  it('returns 304 Not Modified when If-None-Match matches ETag', async () => {
    const app = buildApp();

    const res1 = await request(app)
      .get('/api/usage')
      .set('x-user-id', 'user-1');

    const etag = res1.headers.etag;
    expect(etag).toBeDefined();

    const res2 = await request(app)
      .get('/api/usage')
      .set('x-user-id', 'user-1')
      .set('If-None-Match', etag);

    expect(res2.status).toBe(304);
    expect(res2.text).toBe('');
  });

  it('returns 200 when If-None-Match does not match', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/api/usage')
      .set('x-user-id', 'user-1')
      .set('If-None-Match', 'W/"stale-hash-value"');

    expect(res.status).toBe(200);
    expect(res.body.events).toBeDefined();
  });
});

describe('Usage route structured access logs', () => {
  it('emits structured access log with correlation id', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);

    const app = express();
    app.use('/api/usage', createUsageRouter({ usageEventsRepository: createMockRepo() }));
    app.use(errorHandler);

    try {
      const res = await request(app)
        .get('/api/usage')
        .set('x-user-id', 'user-1')
        .set('x-correlation-id', 'corr-usage-test');

      expect(res.status).toBe(200);

      const usageLogCall = infoSpy.mock.calls.find(
        (call) => call[1] === 'usage request completed',
      );
      expect(usageLogCall).toBeDefined();
      expect(usageLogCall![0]).toEqual(
        expect.objectContaining({
          correlationId: 'corr-usage-test',
          method: 'GET',
          path: '/',
          status: 200,
          statusCode: 200,
          userId: 'user-1',
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});

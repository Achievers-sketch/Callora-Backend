process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.METRICS_API_KEY = 'test-metrics-key';

import { jest } from '@jest/globals';

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => {
    return {
      prepare: jest.fn().mockReturnValue({ get: jest.fn() }),
      exec: jest.fn(),
      close: jest.fn(),
    };
  });
});

import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('Spike Route Timeout Integration Tests', () => {
  let app: any;

  beforeAll(() => {
    app = createApp();
  });

  it('should complete successfully (200 OK) when delay is smaller than timeout', async () => {
    const res = await request(app)
      .get('/api/spike?delay=100&timeout=500');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.delay).toBe(100);
  });

  it('should timeout (504 Gateway Timeout) when delay is larger than default timeout (1000ms)', async () => {
    const res = await request(app)
      .get('/api/spike?delay=1200'); // default timeout is 1000ms

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('GATEWAY_TIMEOUT');
    expect(res.body.message).toBe('Request timeout exceeded');
  });

  it('should timeout (504 Gateway Timeout) when delay is larger than custom query timeout', async () => {
    const res = await request(app)
      .get('/api/spike?delay=500&timeout=200');

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('GATEWAY_TIMEOUT');
    expect(res.body.message).toBe('Request timeout exceeded');
  });

  it('should support custom timeout via x-timeout-ms header', async () => {
    const res = await request(app)
      .get('/api/spike?delay=500')
      .set('x-timeout-ms', '200');

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('GATEWAY_TIMEOUT');
    expect(res.body.message).toBe('Request timeout exceeded');
  });
});

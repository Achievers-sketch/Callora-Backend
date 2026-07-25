import express from 'express';
import request from 'supertest';
import { errorHandler } from './errorHandler.js';
import { createRouteBodyLimitMiddleware } from './routeBodyLimit.js';

describe('createRouteBodyLimitMiddleware', () => {
  test('returns 413 for oversized bodies on a configured route', async () => {
    const app = express();
    app.use(
      createRouteBodyLimitMiddleware([
        { method: 'POST', route: '/checkout', limit: '10b' },
      ]),
    );
    app.use(express.json());
    app.post('/checkout', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const largeBody = { data: 'x'.repeat(64) };
    const res = await request(app).post('/checkout').send(largeBody);

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'Request body too large',
    });
  });

  test('allows bodies that stay within the configured route limit', async () => {
    const app = express();
    app.use(
      createRouteBodyLimitMiddleware([
        { method: 'POST', route: '/checkout', limit: '100b' },
      ]),
    );
    app.use(express.json());
    app.post('/checkout', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    app.use(errorHandler);

    const smallBody = { data: 'x'.repeat(20) };
    const res = await request(app).post('/checkout').send(smallBody);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });
});

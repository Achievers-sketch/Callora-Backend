import express from 'express';
import request from 'supertest';
import { createRouteBodyLimitMiddleware } from './routeBodyLimit.js';

describe('createRouteBodyLimitMiddleware', () => {
  const createTestApp = (limit: string) => {
    const app = express();

    app.use(createRouteBodyLimitMiddleware([{ method: 'POST', route: '/upload', limit }]));
    app.use(express.json());
    app.post('/upload', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    app.use(
      (
        err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        const status = typeof err === 'object' && err && 'status' in err && typeof (err as { status?: number }).status === 'number'
          ? (err as { status: number }).status
          : 500;

        res.status(status).json({
          code: status === 413 ? 'REQUEST_BODY_TOO_LARGE' : 'INTERNAL_SERVER_ERROR',
          message: status === 413 ? 'Request body too large' : 'Internal server error',
        });
      },
    );

    return app;
  };

  it('returns 413 for oversized bodies on a configured route', async () => {
    const app = createTestApp('10kb');

    const response = await request(app)
      .post('/upload')
      .send({ payload: 'x'.repeat(12000) });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'Request body too large',
    });
  });

  it('allows bodies that stay within the configured route limit', async () => {
    const app = createTestApp('20kb');

    const response = await request(app)
      .post('/upload')
      .send({ payload: 'x'.repeat(12000) });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
  });
});

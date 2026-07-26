import { Router, type Request, type Response } from 'express';
import { createTimeoutMiddleware } from '../middleware/timeout.js';
import { successEnvelope } from '../lib/envelope.js';
import { getRequestId } from '../logger.js';
import { GatewayTimeoutError } from '../errors/index.js';

export interface ForecastPoint {
  timestamp: string;
  value: number;
}

export interface ForecastResponse {
  forecast: ForecastPoint[];
  generatedAt: string;
}

function simulateForecastCalculation(signal?: AbortSignal): ForecastPoint[] {
  const now = Date.now();
  const points: ForecastPoint[] = [];

  for (let i = 0; i < 24; i++) {
    if (signal?.aborted) {
      throw new GatewayTimeoutError('Forecast calculation timed out');
    }

    const timestamp = new Date(now + i * 3_600_000).toISOString();
    const value = Math.round(Math.random() * 100 * 100) / 100;
    points.push({ timestamp, value });
  }

  return points;
}

export function createForecastRouter(timeoutMs = 5_000): Router {
  const router = Router();

  router.use(createTimeoutMiddleware({ durationMs: timeoutMs }));

  router.get('/', (req: Request, res: Response) => {
    const requestId = getRequestId(req) ?? 'unknown';
    const forecast = simulateForecastCalculation(req.signal);

    const data: ForecastResponse = {
      forecast,
      generatedAt: new Date().toISOString(),
    };

    res.json(successEnvelope(data, requestId));
  });

  return router;
}

export default createForecastRouter;

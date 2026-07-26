import { Router } from 'express';
import type { RequestHandler } from 'express';
import { readFileSync } from 'fs';
import path from 'path';

import billingRouter from './billing.js';
import { createBillingPortalRouter } from './billing/portal.js';
import healthRouter from './health.js';
import { createApisRouter, type ApisRouterDeps } from './apis.js';
import { createSpikeRouter } from './spike.js';
import { createUsageRouter, type UsageRouterDeps } from './usage.js';
import { createLimitsRouter } from './limits.js';
import { InMemoryRestRateLimiter } from '../middleware/restRateLimit.js';
import { createUsageCsvRouter } from './usage/csv.js';
import { createUsageByEndpointRouter } from './usage/byEndpoint.js';
import { createExportSchedulesRouter } from './exports/schedules.js';
import type { ScheduledExportsService } from '../services/scheduledExports.js';
import { createSubscriptionRouter } from './subscriptionRoutes.js';
import type { SubscriptionRepository } from '../repositories/subscriptionRepository.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import type { ApiRepository } from '../repositories/apiRepository.js';

const openApiPath = path.join(process.cwd(), 'docs/openapi.json');
const openApiSpec = JSON.parse(readFileSync(openApiPath, 'utf8'));

export interface ApiRouterDeps extends Partial<UsageRouterDeps>, Partial<ApisRouterDeps> {
  restRateLimit?: RequestHandler;
  restRateLimiter?: InMemoryRestRateLimiter;
  perDevConcurrency?: RequestHandler;
  scheduledExportsService?: ScheduledExportsService;
  subscriptionRepository?: SubscriptionRepository;
  developerRepository?: DeveloperRepository;
  apiRepository?: ApiRepository;
}

export function createApiRouter(deps: ApiRouterDeps = {}): Router {
  const router = Router();

  router.use('/health', healthRouter);
  router.use('/spike', createSpikeRouter());
  
  router.use('/apis', createApisRouter({
    apiRepository: deps.apiRepository,
    developerRepository: deps.developerRepository
  }));

  // Mounted before '/usage' so the more specific CSV export path matches first.
  router.use('/usage/csv', createUsageCsvRouter({
    usageEventsRepository: deps.usageEventsRepository!
  }));

  router.use('/usage/by-endpoint', createUsageByEndpointRouter({
    usageEventsRepository: deps.usageEventsRepository!
  }));

  router.use('/usage', createUsageRouter({
    usageEventsRepository: deps.usageEventsRepository!
  }));

  if (deps.scheduledExportsService) {
    router.use('/exports/schedules', createExportSchedulesRouter(deps.scheduledExportsService));
  }

  // Subscriptions — developers subscribe to marketplace APIs with metering preferences.
  if (deps.subscriptionRepository && deps.apiRepository && deps.developerRepository) {
    router.use(
      '/subscriptions',
      createSubscriptionRouter({
        subscriptionRepository: deps.subscriptionRepository,
        apiRepository: deps.apiRepository,
        developerRepository: deps.developerRepository,
      }),
    );
  }

  // Per-developer concurrency middleware for billing routes — applied BEFORE
  // the rate limiter so concurrency rejections are fast-fail and don't consume
  // rate-limit budget.
  const billingConcurrency = deps.perDevConcurrency;
  const billingMiddlewares: RequestHandler[] = [];
  if (billingConcurrency) {
    billingMiddlewares.push(billingConcurrency);
  }
  if (deps.restRateLimit) {
    billingMiddlewares.push(deps.restRateLimit);
  }

  if (billingMiddlewares.length > 0) {
    router.use('/billing', ...billingMiddlewares, billingRouter);
    router.use('/billing/portal', ...billingMiddlewares, createBillingPortalRouter());
  } else {
    router.use('/billing', billingRouter);
    router.use('/billing/portal', createBillingPortalRouter());
  }

  if (deps.restRateLimiter) {
    router.use('/limits', createLimitsRouter(deps.restRateLimiter).router);
  }

  // Serve OpenAPI 3.1 JSON contract
  router.get('/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(openApiSpec);
  });

  return router;
}

export default createApiRouter;

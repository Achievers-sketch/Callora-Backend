import express from 'express';
import request from 'supertest';

import type { Credit } from '../../../../db/schema.js';
import { errorHandler } from '../../../../middleware/errorHandler.js';
import type { CreditsRepository } from '../../../../repositories/creditsRepository.js';
import { createAdminCreditGrantsRouter } from './grant.js';

const ADMIN_KEY = 'test-admin-key';

function makeCredit(overrides: Partial<Credit> = {}): Credit {
  const now = new Date('2026-07-24T00:00:00.000Z');
  return {
    id: 1,
    user_id: 'user_123',
    balance_usdc: '0.00',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function buildApp(creditsRepository: CreditsRepository) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.adminActor = 'admin-api-key';
    next();
  });
  app.use('/api/admin/billing/credits', createAdminCreditGrantsRouter({ creditsRepository }));
  app.use(errorHandler);
  return app;
}

function makeRepository(): jest.Mocked<CreditsRepository> {
  return {
    findByUserId: jest.fn(),
    getOrCreateByUserId: jest.fn(),
    updateBalance: jest.fn(),
    grant: jest.fn().mockResolvedValue(makeCredit({ balance_usdc: '25.50' })),
  };
}

describe('POST /api/admin/billing/credits/grant', () => {
  it('grants prepaid credits and returns the resulting balance', async () => {
    const repository = makeRepository();
    const response = await request(buildApp(repository))
      .post('/api/admin/billing/credits/grant')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ user_id: 'user_123', amount_usdc: '25.50' });

    expect(response.status).toBe(201);
    expect(repository.grant).toHaveBeenCalledWith('user_123', '29.50');
    expect(response.body.data).toMatchObject({
      user_id: 'user_123',
      amount_usdc: '29.50',
      balance_usdc: '25.50',
      campaign: 'GrantFox FWC26',
    });
  });

  it.each(['0', '0.0000000', '-1', '1.00000001', '1e3'])(
    'rejects invalid grant amount %s',
    async (amount_usdc) => {
      const repository = makeRepository();
      const response = await request(buildApp(repository))
        .post('/api/admin/billing/credits/grant')
        .set('x-admin-api-key', ADMIN_KEY)
        .send({ user_id: 'user_123', amount_usdc });

      expect(response.status).toBe(400);
      expect(repository.grant).not.toHaveBeenCalled();
    },
  );

  it('rejects unexpected request fields', async () => {
    const repository = makeRepository();
    const response = await request(buildApp(repository))
      .post('/api/admin/billing/credits/grant')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ user_id: 'user_123', amount_usdc: '1.00', campaign: 'override' });

    expect(response.status).toBe(400);
    expect(repository.grant).not.toHaveBeenCalled();
  });

  it('requires admin authentication before issuing credits', async () => {
    const repository = makeRepository();
    const response = await request(buildApp(repository))
      .post('/api/admin/billing/credits/grant')
      .send({ user_id: 'user_123', amount_usdc: '1.00' });

    expect(response.status).toBe(401);
    expect(repository.grant).not.toHaveBeenCalled();
  });
});

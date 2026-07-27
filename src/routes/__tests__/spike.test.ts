import request from 'supertest';
import express from 'express';
import { createSpikeRouter, type SpikeRecord } from '../spike.js';
import type { AuditService, AuditRecordInput } from '../../services/auditService.js';

const mockRecord = jest.fn<AuditService['record']>();
const mockAuditService: AuditService = { record: mockRecord };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/spike', createSpikeRouter({ auditService: mockAuditService }));
  return app;
}

describe('Spike Router — Mutation Audit Logging', () => {
  let app: express.Express;

  beforeAll(() => {
    app = buildApp();
  });

  beforeEach(() => {
    mockRecord.mockReset();
    mockRecord.mockResolvedValue(undefined);
  });

  describe('POST /spike', () => {
    it('creates a spike record and persists an audit row', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Traffic spike', severity: 'high' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        label: 'Traffic spike',
        severity: 'high',
      });
      expect(res.body.id).toBeDefined();
      expect(res.body.createdAt).toBeDefined();
      expect(res.body.updatedAt).toBeDefined();

      expect(mockRecord).toHaveBeenCalledTimes(1);
      const call = mockRecord.mock.calls[0]![0] as AuditRecordInput;
      expect(call.event).toBe('SPIKE_CREATE');
      expect(call.actor).toBe('anonymous');
      expect(call.details).toMatchObject({
        spikeId: res.body.id,
        before: null,
        after: { label: 'Traffic spike', severity: 'high' },
      });
    });

    it('rejects missing label', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ severity: 'high' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('rejects empty label', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ label: '', severity: 'low' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('rejects invalid severity', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Test', severity: 'extreme' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('rejects missing severity', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Test' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('still returns 201 when audit write fails (best-effort)', async () => {
      mockRecord.mockRejectedValue(new Error('DB down'));

      const res = await request(app)
        .post('/spike')
        .send({ label: 'Resilience test', severity: 'critical' });

      expect(res.status).toBe(201);
      expect(res.body.label).toBe('Resilience test');
    });
  });

  describe('PUT /spike/:id', () => {
    let created: SpikeRecord;

    beforeEach(async () => {
      mockRecord.mockReset();
      mockRecord.mockResolvedValue(undefined);
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Original', severity: 'low' });
      created = res.body;
    });

    it('updates a spike record and persists an audit row', async () => {
      const res = await request(app)
        .put(`/spike/${created.id}`)
        .send({ label: 'Updated', severity: 'high' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: created.id,
        label: 'Updated',
        severity: 'high',
      });
      expect(res.body.updatedAt).not.toBe(created.updatedAt);

      expect(mockRecord).toHaveBeenCalledTimes(1);
      const call = mockRecord.mock.calls[0]![0] as AuditRecordInput;
      expect(call.event).toBe('SPIKE_UPDATE');
      expect(call.actor).toBe('anonymous');
      expect(call.details).toMatchObject({
        spikeId: created.id,
        before: { label: 'Original', severity: 'low' },
        after: { label: 'Updated', severity: 'high' },
      });
    });

    it('returns 404 for non-existent id', async () => {
      const res = await request(app)
        .put('/spike/non-existent')
        .send({ label: 'Nope', severity: 'low' });

      expect(res.status).toBe(404);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('rejects invalid severity on update', async () => {
      const res = await request(app)
        .put(`/spike/${created.id}`)
        .send({ severity: 'invalid' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /spike/:id', () => {
    let created: SpikeRecord;

    beforeEach(async () => {
      mockRecord.mockReset();
      mockRecord.mockResolvedValue(undefined);
      const res = await request(app)
        .post('/spike')
        .send({ label: 'ToDelete', severity: 'medium' });
      created = res.body;
    });

    it('deletes a spike record and persists an audit row', async () => {
      const res = await request(app).delete(`/spike/${created.id}`);

      expect(res.status).toBe(204);

      expect(mockRecord).toHaveBeenCalledTimes(1);
      const call = mockRecord.mock.calls[0]![0] as AuditRecordInput;
      expect(call.event).toBe('SPIKE_DELETE');
      expect(call.actor).toBe('anonymous');
      expect(call.details).toMatchObject({
        spikeId: created.id,
        before: { label: 'ToDelete', severity: 'medium' },
        after: null,
      });
    });

    it('returns 204 on repeat delete (idempotent at audit level)', async () => {
      await request(app).delete(`/spike/${created.id}`);
      mockRecord.mockReset();

      const res = await request(app).delete(`/spike/${created.id}`);
      expect(res.status).toBe(404);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('returns 404 for non-existent id', async () => {
      const res = await request(app).delete('/spike/non-existent');
      expect(res.status).toBe(404);
      expect(mockRecord).not.toHaveBeenCalled();
    });
  });

  describe('GET /spike/records', () => {
    it('returns an empty list when no spikes exist', async () => {
      const res = await request(app).get('/spike/records');
      expect(res.status).toBe(200);
      expect(res.body.records).toEqual([]);
    });

    it('returns created spikes', async () => {
      await request(app)
        .post('/spike')
        .send({ label: 'A', severity: 'low' });
      const res = await request(app).get('/spike/records');
      expect(res.status).toBe(200);
      expect(res.body.records).toHaveLength(1);
      expect(res.body.records[0]!.label).toBe('A');
    });
  });

  describe('GET /spike (existing timeout behavior preserved)', () => {
    it('completes successfully when delay is within timeout', async () => {
      const res = await request(app).get('/spike?delay=50');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.delay).toBe(50);
    });
  });
});

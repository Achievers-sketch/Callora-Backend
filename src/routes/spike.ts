import { Router } from 'express';
import type { Request } from 'express';
import { createTimeoutMiddleware } from '../middleware/timeout.js';
import { defaultAuditService, type AuditService } from '../services/auditService.js';
import { logger } from '../logger.js';
import { NotFoundError, BadRequestError } from '../errors/index.js';

export interface SpikeRecord {
  id: string;
  label: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
  updatedAt: string;
}

export interface SpikeRouterDeps {
  auditService?: AuditService;
}

const spikeStore: SpikeRecord[] = [];
let nextId = 1;

export function createSpikeRouter(deps: SpikeRouterDeps = {}): Router {
  const router = Router();
  const auditService = deps.auditService ?? defaultAuditService;

  async function recordAudit(
    req: Request,
    event: string,
    actor: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const ctx = req.auditContext;
    try {
      await auditService.record({
        event,
        actor,
        tenantId: ctx?.tenantId ?? null,
        clientIp: ctx?.clientIp ?? null,
        userAgent: ctx?.userAgent ?? null,
        correlationId: ctx?.correlationId ?? null,
        bodyHash: ctx?.bodyHash ?? null,
        details,
      });
    } catch (error) {
      logger.error(
        { event, actor, correlationId: ctx?.correlationId, err: error },
        'Failed to persist audit log for spike mutation',
      );
    }
  }

  router.get('/', createTimeoutMiddleware({ timeoutMs: 1000 }), async (req, res, next) => {
    try {
      let delay = 2000;
      if (typeof req.query.delay === 'string') {
        const parsed = parseInt(req.query.delay, 10);
        if (!isNaN(parsed) && parsed > 0) {
          delay = parsed;
        }
      }

      const sleepInterval = 50;
      let elapsed = 0;

      while (elapsed < delay) {
        if (req.signal?.aborted) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, sleepInterval));
        elapsed += sleepInterval;
      }

      res.json({
        success: true,
        message: 'Spike completed successfully',
        delay,
        elapsed,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/records', (_req, res) => {
    res.json({ records: spikeStore });
  });

  router.post('/', async (req, res, next) => {
    try {
      const { label, severity } = req.body ?? {};

      if (!label || typeof label !== 'string' || label.trim().length === 0) {
        next(new BadRequestError('label is required and must be a non-empty string'));
        return;
      }

      const validSeverities = ['low', 'medium', 'high', 'critical'] as const;
      if (!severity || !validSeverities.includes(severity)) {
        next(new BadRequestError(`severity must be one of: ${validSeverities.join(', ')}`));
        return;
      }

      const id = String(nextId++);
      const now = new Date().toISOString();
      const record: SpikeRecord = {
        id,
        label: label.trim(),
        severity,
        createdAt: now,
        updatedAt: now,
      };

      spikeStore.push(record);

      const actor = req.developerId ?? 'anonymous';

      await recordAudit(req, 'SPIKE_CREATE', actor, {
        spikeId: id,
        before: null,
        after: { label: record.label, severity: record.severity },
      });

      res.status(201).json(record);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const index = spikeStore.findIndex((r) => r.id === id);

      if (index === -1) {
        next(new NotFoundError(`Spike record ${id} not found`));
        return;
      }

      const existing = spikeStore[index]!;
      const { label, severity } = req.body ?? {};

      const validSeverities = ['low', 'medium', 'high', 'critical'] as const;

      if (label !== undefined && (typeof label !== 'string' || label.trim().length === 0)) {
        next(new BadRequestError('label must be a non-empty string'));
        return;
      }

      if (severity !== undefined && !validSeverities.includes(severity)) {
        next(new BadRequestError(`severity must be one of: ${validSeverities.join(', ')}`));
        return;
      }

      const updated: SpikeRecord = {
        ...existing,
        label: label !== undefined ? label.trim() : existing.label,
        severity: severity !== undefined ? severity : existing.severity,
        updatedAt: new Date().toISOString(),
      };

      spikeStore[index] = updated;

      const actor = req.developerId ?? 'anonymous';

      await recordAudit(req, 'SPIKE_UPDATE', actor, {
        spikeId: id,
        before: { label: existing.label, severity: existing.severity },
        after: { label: updated.label, severity: updated.severity },
      });

      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const index = spikeStore.findIndex((r) => r.id === id);

      if (index === -1) {
        next(new NotFoundError(`Spike record ${id} not found`));
        return;
      }

      const removed = spikeStore.splice(index, 1)[0]!;

      const actor = req.developerId ?? 'anonymous';

      await recordAudit(req, 'SPIKE_DELETE', actor, {
        spikeId: id,
        before: { label: removed.label, severity: removed.severity },
        after: null,
      });

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

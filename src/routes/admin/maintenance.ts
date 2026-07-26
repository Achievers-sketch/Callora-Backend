import { Router, Request, Response } from 'express';
import { createMaintenanceCorsMiddleware } from '../../middleware/cors.js';

const maintenanceCors = createMaintenanceCorsMiddleware();

export const maintenanceRouter = Router();

maintenanceRouter.use(maintenanceCors);

// Global runtime state store tracking scheduled maintenance window configuration parameters
export let activeMaintenanceWindow = {
  isEnabled: false,
  startTime: null as string | null,
  endTime: null as string | null,
  reason: '',
};

maintenanceRouter.post('/maintenance', (req: Request, res: Response): void => {
  const correlationId = getCorrelationId() ?? req.correlationId;
  const { isEnabled, startTime, endTime, reason } = req.body;

  logger.info('Maintenance window update requested', { correlationId, isEnabled });

  if (typeof isEnabled !== 'boolean') {
    res.status(400).json({
      error: 'Property "isEnabled" must be an explicit boolean value.',
      correlationId,
    });
    return;
  }

  if (isEnabled) {
    if (!startTime || !endTime) {
      res.status(400).json({
        error: 'startTime and endTime ISO parameters are mandatory when maintenance is active.',
        correlationId,
      });
      return;
    }

    if (isNaN(Date.parse(startTime)) || !isNaN(Number(startTime)) || isNaN(Date.parse(endTime)) || !isNaN(Number(endTime))) {
      res.status(400).json({
        error: 'Invalid ISO date strings provided for tracking windows.',
        correlationId,
      });
      return;
    }
  }

  activeMaintenanceWindow = {
    isEnabled,
    startTime: isEnabled ? new Date(startTime).toISOString() : null,
    endTime: isEnabled ? new Date(endTime).toISOString() : null,
    reason: reason || 'Scheduled infrastructure updates.',
  };

  logger.info('Maintenance window updated', { correlationId, activeMaintenanceWindow });

  res.status(200).json({
    message: 'Maintenance window state configurations updated successfully.',
    data: activeMaintenanceWindow,
    correlationId,
  });
});

maintenanceRouter.get('/maintenance', (req: Request, res: Response) => {
  const correlationId = getCorrelationId() ?? req.correlationId;

  logger.info('Maintenance window status requested', { correlationId });

  res.status(200).json({
    ...activeMaintenanceWindow,
    correlationId,
  });
});

export { buildOutboundCorrelationHeaders };

import { z } from 'zod';

export const auditQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => {
      if (val === undefined) return 20;
      const num = Number(val);
      if (Number.isNaN(num) || !Number.isInteger(num)) {
        throw new Error('Limit must be an integer');
      }
      return num;
    })
    .refine((val) => val >= 1 && val <= 100, {
      message: 'Limit must be between 1 and 100',
    }),
  cursor: z.string().optional(),
  event: z.string().optional().transform((val) => (val && val.trim() !== '' ? val.trim() : undefined)),
  tenant_id: z.string().optional().transform((val) => (val && val.trim() !== '' ? val.trim() : undefined)),
  actor: z.string().optional().transform((val) => (val && val.trim() !== '' ? val.trim() : undefined)),
  from: z
    .string()
    .optional()
    .transform((val) => {
      if (val === undefined || val.trim() === '') return undefined;
      const date = new Date(val);
      if (Number.isNaN(date.getTime())) {
        throw new Error('Invalid "from" date');
      }
      return date;
    }),
  to: z
    .string()
    .optional()
    .transform((val) => {
      if (val === undefined || val.trim() === '') return undefined;
      const date = new Date(val);
      if (Number.isNaN(date.getTime())) {
        throw new Error('Invalid "to" date');
      }
      return date;
    }),
}).refine((data) => {
  if (data.from && data.to && data.from.getTime() > data.to.getTime()) {
    return false;
  }
  return true;
}, {
  message: '"from" must be before or equal to "to"',
  path: ['from'],
});

export type AuditQueryInput = z.infer<typeof auditQuerySchema>;

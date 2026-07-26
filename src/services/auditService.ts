import { randomUUID } from 'node:crypto';
import { writeQuery } from '../db.js';

/**
 * A single audit entry to persist. `event` is the action taken, `actor` is the
 * authenticated caller, and `details` carries the state change (before/after)
 * plus any extra context. Forensic fields (tenant, ip, user-agent, correlation
 * id, body hash) come from the request's `auditContext` when available.
 */
export interface AuditRecordInput {
  event: string;
  actor: string;
  tenantId?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  bodyHash?: string | null;
  details?: Record<string, unknown> | null;
}

export interface AuditService {
  record(input: AuditRecordInput): Promise<void>;
}

class PgAuditService implements AuditService {
  async record(input: AuditRecordInput): Promise<void> {
    await writeQuery(
      `INSERT INTO audit_logs (
         id, event, actor, tenant_id, client_ip, user_agent,
         correlation_id, body_hash, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        input.event,
        input.actor,
        input.tenantId ?? null,
        input.clientIp ?? null,
        input.userAgent ?? null,
        input.correlationId ?? null,
        input.bodyHash ?? null,
        input.details ? JSON.stringify(input.details) : null,
      ],
    );
  }
}

export const defaultAuditService: AuditService = new PgAuditService();

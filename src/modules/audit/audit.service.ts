import type { AuditExecutor } from './audit.repository';
import type { AuditContext, AuditEvent, AuditMutation, AuditQuery } from './audit.types';
import type { AuditLog } from '@/db/schema';
import { AUDIT_VERBS, auditAction } from '@/constants/audit';
import { AuditRepository } from './audit.repository';
import { auditDiff, sanitizeAuditValue } from './audit.utils';

type AuditDb = AuditExecutor;

export class AuditService {
  async log(db: AuditDb, context: AuditContext, event: AuditEvent): Promise<AuditLog> {
    const before = sanitizeAuditValue(event.before);
    const after = sanitizeAuditValue(event.after);
    const changes = event.changes === undefined
      ? before !== null && after !== null ? auditDiff(before, after) : null
      : sanitizeAuditValue(event.changes);

    return new AuditRepository(db).insertLog({
      tenantId: context.tenantId,
      actorId: context.actorId,
      actorSessionId: context.actorSessionId ?? null,
      actorType: context.actorType,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      oldValues: before,
      newValues: after,
      changes,
      requestId: context.requestId ?? null,
      correlationId: context.correlationId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      metadata: sanitizeAuditValue(event.metadata),
    });
  }

  async created(db: AuditDb, context: AuditContext, event: AuditMutation & { after: Record<string, unknown> }): Promise<AuditLog> {
    return this.log(db, context, { ...event, action: auditAction(event.entityType, AUDIT_VERBS.CREATED) });
  }

  async updated(db: AuditDb, context: AuditContext, event: AuditMutation & { before: Record<string, unknown>; after: Record<string, unknown> }): Promise<AuditLog> {
    return this.log(db, context, { ...event, action: auditAction(event.entityType, AUDIT_VERBS.UPDATED) });
  }

  async deleted(db: AuditDb, context: AuditContext, event: AuditMutation & { before: Record<string, unknown> }): Promise<AuditLog> {
    return this.log(db, context, { ...event, action: auditAction(event.entityType, AUDIT_VERBS.DELETED) });
  }

  async list(db: AuditDb, query: AuditQuery): Promise<AuditLog[]> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Audit query limit must be between 1 and 100');

    return new AuditRepository(db).listLogs(query, limit);
  }
}

export const audit = new AuditService();

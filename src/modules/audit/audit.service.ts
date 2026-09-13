import type { AuditContext, AuditEvent, AuditMutation, AuditQuery } from './audit.types';
import type { AuditLog } from '@/db/schema';
import type { Database } from '@/plugins/database';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { auditLogs } from '@/db/schema';
import { auditDiff, sanitizeAuditValue } from './audit.utils';

type AuditDb = Pick<Database, 'insert' | 'select'>;

export class AuditService {
  async log(db: AuditDb, context: AuditContext, event: AuditEvent): Promise<AuditLog> {
    const before = sanitizeAuditValue(event.before);
    const after = sanitizeAuditValue(event.after);
    const changes = event.changes === undefined
      ? before !== null && after !== null ? auditDiff(before, after) : null
      : sanitizeAuditValue(event.changes);

    const [row] = await db.insert(auditLogs).values({
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
    }).returning();

    if (!row)
      throw new Error('Audit insert returned no row');
    return row;
  }

  async created(db: AuditDb, context: AuditContext, event: AuditMutation & { after: Record<string, unknown> }): Promise<AuditLog> {
    return this.log(db, context, { ...event, action: `${event.entityType}.created` });
  }

  async updated(db: AuditDb, context: AuditContext, event: AuditMutation & { before: Record<string, unknown>; after: Record<string, unknown> }): Promise<AuditLog> {
    return this.log(db, context, { ...event, action: `${event.entityType}.updated` });
  }

  async deleted(db: AuditDb, context: AuditContext, event: AuditMutation & { before: Record<string, unknown> }): Promise<AuditLog> {
    return this.log(db, context, { ...event, action: `${event.entityType}.deleted` });
  }

  async list(db: AuditDb, query: AuditQuery): Promise<AuditLog[]> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Audit query limit must be between 1 and 100');

    return db.select().from(auditLogs).where(and(
      query.tenantId === null ? isNull(auditLogs.tenantId) : eq(auditLogs.tenantId, query.tenantId),
      query.entityType === undefined ? undefined : eq(auditLogs.entityType, query.entityType),
      query.entityId === undefined ? undefined : eq(auditLogs.entityId, query.entityId),
      query.actorId === undefined ? undefined : eq(auditLogs.actorId, query.actorId),
      query.action === undefined ? undefined : eq(auditLogs.action, query.action),
      query.before === undefined
        ? undefined
        : or(
            lt(auditLogs.createdAt, query.before.createdAt),
            and(eq(auditLogs.createdAt, query.before.createdAt), lt(auditLogs.id, query.before.id)),
          ),
    )).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(limit);
  }
}

export const audit = new AuditService();

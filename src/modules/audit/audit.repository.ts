import type { SQL } from 'drizzle-orm';
import type { AuditQuery } from './audit.types';
import type { Database } from '@/db/client';
import type { AuditLog } from '@/db/schema';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { auditLogs } from '@/db/schema';

/**
 * Audit rows have to land on the executor the caller is already using — a write
 * that lands outside the caller's transaction survives its rollback and records
 * a change that never happened. So this takes the executor per call rather than
 * holding one, and the service constructs it around whatever `tx` it has.
 */
export type AuditExecutor = Pick<Database, 'insert' | 'select'>;

export class AuditRepository {
  constructor(private readonly db: AuditExecutor) {}

  async insertLog(data: typeof auditLogs.$inferInsert): Promise<AuditLog> {
    const [row] = await this.db.insert(auditLogs).values(data).returning();

    if (!row)
      throw new Error('Audit insert returned no row');

    return row;
  }

  async listLogs(query: AuditQuery, limit: number): Promise<AuditLog[]> {
    return this.db
      .select()
      .from(auditLogs)
      .where(and(...this.filtersFor(query)))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit);
  }

  private filtersFor(query: AuditQuery): (SQL | undefined)[] {
    return [
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
    ];
  }
}

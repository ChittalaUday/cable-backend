import type { SQL } from 'drizzle-orm';
import type { Database } from '@/db/client';
import type { AuditLog } from '@/db/schema';
import { and, desc } from 'drizzle-orm';
import { auditLogs } from '@/db/schema';

export class AuditRepository {
  constructor(private readonly db: Database) {}

  async insertLog(data: typeof auditLogs.$inferInsert): Promise<AuditLog> {
    const [row] = await this.db.insert(auditLogs).values(data).returning();
    if (!row)
      throw new Error('Audit insert returned no row');
    return row;
  }

  async listLogs(conditions: SQL[], limit = 50): Promise<AuditLog[]> {
    return this.db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit);
  }
}

import type { SQL } from 'drizzle-orm';
import type { RemoteDeviceType } from '@/constants/remotes';
import type { Database } from '@/db/client';
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { remotes } from '@/db/schema';

export class RemoteRepository {
  constructor(private readonly db: Database) {}

  async listRemotes(tenantId: string, query: { deviceType?: string; brand?: string; q?: string }) {
    const conditions: SQL[] = [
      or(isNull(remotes.tenantId), eq(remotes.tenantId, tenantId))!,
    ];

    if (query.deviceType !== undefined)
      conditions.push(eq(remotes.deviceType, query.deviceType as RemoteDeviceType));

    if (query.brand !== undefined)
      conditions.push(ilike(remotes.brand, query.brand));

    if (query.q !== undefined && query.q.trim() !== '') {
      const pattern = `%${query.q.trim()}%`;
      conditions.push(or(ilike(remotes.brand, pattern), ilike(remotes.model, pattern))!);
    }

    return this.db
      .select({
        id: remotes.id,
        tenantId: remotes.tenantId,
        deviceType: remotes.deviceType,
        brand: remotes.brand,
        model: remotes.model,
        source: remotes.source,
        verified: remotes.verified,
        notes: remotes.notes,
        createdAt: remotes.createdAt,
        updatedAt: remotes.updatedAt,
        buttonCount: sql<number>`jsonb_array_length(${remotes.buttons})::int`,
      })
      .from(remotes)
      .where(and(...conditions))
      .orderBy(asc(remotes.brand), asc(remotes.model));
  }

  async findRemoteById(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(remotes)
      .where(and(
        eq(remotes.id, id),
        or(isNull(remotes.tenantId), eq(remotes.tenantId, tenantId)),
      ))
      .limit(1);

    return row ?? null;
  }

  async createRemote(data: typeof remotes.$inferInsert) {
    const [created] = await this.db.insert(remotes).values(data).returning();
    return created!;
  }
}

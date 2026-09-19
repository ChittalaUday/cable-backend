import type { SQL } from 'drizzle-orm';
import type { Database } from '@/db/client';
import type { RemoteCaptureRecord, RemoteRecord } from '@/db/schema';
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { remoteCaptures, remotes } from '@/db/schema';

export interface RemoteListFilter {
  deviceType?: string;
  brand?: string;
  search?: string;
}

export type RemoteSummaryRow = Omit<RemoteRecord, 'buttons'> & { buttonCount: number };

export class RemoteRepository {
  constructor(private readonly db: Database) {}

  /** The audit trail is written by the service but must land on this same executor. */
  get database(): Database {
    return this.db;
  }

  // The shared library rows carry tenant_id NULL; every read has to let those
  // through alongside the caller's own captures, which is why this is `or` and
  // not the usual flat tenant equality.
  private visibleTo(tenantId: string): SQL {
    return or(isNull(remotes.tenantId), eq(remotes.tenantId, tenantId))!;
  }

  async listRemotes(tenantId: string, filter: RemoteListFilter): Promise<RemoteSummaryRow[]> {
    const conditions: SQL[] = [this.visibleTo(tenantId)];

    if (filter.deviceType !== undefined)
      conditions.push(eq(remotes.deviceType, filter.deviceType as RemoteRecord['deviceType']));

    if (filter.brand !== undefined)
      conditions.push(ilike(remotes.brand, filter.brand));

    if (filter.search !== undefined && filter.search.trim() !== '') {
      const pattern = `%${filter.search.trim()}%`;
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
      .orderBy(asc(remotes.deviceType), asc(remotes.brand), asc(remotes.model));
  }

  async findRemoteById(tenantId: string, id: string): Promise<RemoteRecord | null> {
    const [row] = await this.db
      .select()
      .from(remotes)
      .where(and(eq(remotes.id, id), this.visibleTo(tenantId)))
      .limit(1);

    return row ?? null;
  }

  async findCaptures(remoteId: string): Promise<RemoteCaptureRecord[]> {
    return this.db
      .select()
      .from(remoteCaptures)
      .where(eq(remoteCaptures.remoteId, remoteId))
      .orderBy(asc(remoteCaptures.buttonName));
  }

  async createRemote(data: typeof remotes.$inferInsert): Promise<RemoteRecord> {
    const [created] = await this.db.insert(remotes).values(data).returning();
    return created!;
  }
}

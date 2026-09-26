import type { CreateUpiAccountBody, UpdateUpiAccountBody } from './tenant.schema';
import type { Database, Transaction } from '@/db/client';
import type { TenantUpiAccount } from '@/db/schema';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import { tenantUpiAccounts } from '@/db/schema';

export class TenantRepository {
  constructor(private readonly db: Database) {}

  async inTransaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(run);
  }

  /** Live handles, the default first, then newest — the order the picker shows. */
  async listUpiAccounts(tenantId: string, liveOnly: boolean): Promise<TenantUpiAccount[]> {
    return this.db
      .select()
      .from(tenantUpiAccounts)
      .where(and(
        eq(tenantUpiAccounts.tenantId, tenantId),
        isNull(tenantUpiAccounts.deletedAt),
        ...(liveOnly ? [eq(tenantUpiAccounts.status, 'active')] : []),
      ))
      .orderBy(desc(tenantUpiAccounts.isDefault), asc(tenantUpiAccounts.createdAt));
  }

  async findUpiAccount(tx: Transaction, tenantId: string, id: string): Promise<TenantUpiAccount | null> {
    const [row] = await tx
      .select()
      .from(tenantUpiAccounts)
      .where(and(
        eq(tenantUpiAccounts.tenantId, tenantId),
        eq(tenantUpiAccounts.id, id),
        isNull(tenantUpiAccounts.deletedAt),
      ))
      .limit(1);

    return row ?? null;
  }

  async countUpiAccounts(tx: Transaction, tenantId: string): Promise<number> {
    const rows = await tx
      .select({ id: tenantUpiAccounts.id })
      .from(tenantUpiAccounts)
      .where(and(
        eq(tenantUpiAccounts.tenantId, tenantId),
        isNull(tenantUpiAccounts.deletedAt),
      ));

    return rows.length;
  }

  async insertUpiAccount(
    tx: Transaction,
    tenantId: string,
    input: CreateUpiAccountBody & { isDefault: boolean },
  ): Promise<TenantUpiAccount> {
    const [row] = await tx
      .insert(tenantUpiAccounts)
      .values({
        tenantId,
        upiId: input.upiId,
        payeeName: input.payeeName,
        label: input.label ?? null,
        isDefault: input.isDefault,
      })
      .returning();

    return row!;
  }

  async updateUpiAccount(
    tx: Transaction,
    tenantId: string,
    id: string,
    patch: UpdateUpiAccountBody,
  ): Promise<TenantUpiAccount> {
    const [row] = await tx
      .update(tenantUpiAccounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(tenantUpiAccounts.tenantId, tenantId), eq(tenantUpiAccounts.id, id)))
      .returning();

    return row!;
  }

  /** Soft-deletes, and stands the handle down as default in the same stroke. */
  async softDeleteUpiAccount(tx: Transaction, tenantId: string, id: string): Promise<void> {
    await tx
      .update(tenantUpiAccounts)
      .set({ deletedAt: new Date(), isDefault: false, updatedAt: new Date() })
      .where(and(eq(tenantUpiAccounts.tenantId, tenantId), eq(tenantUpiAccounts.id, id)));
  }

  /** Exactly one default per tenant: everything but `keepId` steps down. */
  async clearDefaultExcept(tx: Transaction, tenantId: string, keepId: string): Promise<void> {
    await tx
      .update(tenantUpiAccounts)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(
        eq(tenantUpiAccounts.tenantId, tenantId),
        ne(tenantUpiAccounts.id, keepId),
        eq(tenantUpiAccounts.isDefault, true),
      ));
  }

  /** The oldest live handle, used to re-seat a default the admin just removed. */
  async oldestLiveUpiAccount(tx: Transaction, tenantId: string): Promise<TenantUpiAccount | null> {
    const [row] = await tx
      .select()
      .from(tenantUpiAccounts)
      .where(and(
        eq(tenantUpiAccounts.tenantId, tenantId),
        isNull(tenantUpiAccounts.deletedAt),
        eq(tenantUpiAccounts.status, 'active'),
      ))
      .orderBy(asc(tenantUpiAccounts.createdAt))
      .limit(1);

    return row ?? null;
  }
}

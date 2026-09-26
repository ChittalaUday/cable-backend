import type { CreateUpiAccountBody, UpdateUpiAccountBody, UpiAccount } from './tenant.schema';
import type { Database, Transaction } from '@/db/client';
import type { TenantUpiAccount } from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { conflict, notFound } from '@/errors/domain-error';
import { isUniqueViolation } from '@/errors/postgres';
import { audit } from '@/modules/audit/audit.service';
import { TenantRepository } from './tenant.repository';

function toUpiAccount(row: TenantUpiAccount): UpiAccount {
  return {
    id: row.id,
    upiId: row.upiId,
    payeeName: row.payeeName,
    label: row.label,
    isDefault: row.isDefault,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export class TenantService {
  private readonly repo: TenantRepository;

  constructor(repoOrDb: TenantRepository | Database) {
    this.repo = repoOrDb instanceof TenantRepository ? repoOrDb : new TenantRepository(repoOrDb);
  }

  /**
   * The handles this tenant collects into.
   *
   * A collector gets the live ones only — an inactive handle is one the office
   * has stood down, and showing its QR at a door would send money nowhere
   * anybody is watching. An admin managing the list sees all of them.
   */
  async listUpiAccounts(access: RequestAccess, includeInactive: boolean): Promise<UpiAccount[]> {
    const rows = await this.repo.listUpiAccounts(access.tenantId, !includeInactive);

    return rows.map(toUpiAccount);
  }

  async addUpiAccount(access: RequestAccess, input: CreateUpiAccountBody): Promise<UpiAccount> {
    return this.repo.inTransaction(async (tx) => {
      // The first handle is the default whatever the caller said: a list of one
      // with nothing marked would leave the collector with no QR to show.
      const isFirst = await this.repo.countUpiAccounts(tx, access.tenantId) === 0;
      const isDefault = isFirst || input.isDefault === true;

      const created = await this.insertOrConflict(tx, access.tenantId, { ...input, isDefault });

      if (isDefault)
        await this.repo.clearDefaultExcept(tx, access.tenantId, created.id);

      await audit.created(tx, access.audit, {
        entityType: AUDIT_ENTITIES.TENANT_UPI_ACCOUNT,
        entityId: created.id,
        after: created,
      });

      return toUpiAccount(created);
    });
  }

  async updateUpiAccount(
    access: RequestAccess,
    id: string,
    patch: UpdateUpiAccountBody,
  ): Promise<UpiAccount> {
    return this.repo.inTransaction(async (tx) => {
      const before = await this.repo.findUpiAccount(tx, access.tenantId, id);

      if (before === null)
        throw notFound('UPI account');

      // Standing the only live handle down leaves a collector with nothing to
      // show, so it is refused rather than silently emptying the picker.
      if (patch.status === 'inactive' && before.status === 'active')
        await this.assertNotTheLastLiveOne(access.tenantId, id);

      const after = await this.updateOrConflict(tx, access.tenantId, id, patch);

      if (patch.isDefault === true)
        await this.repo.clearDefaultExcept(tx, access.tenantId, id);

      await audit.updated(tx, access.audit, {
        entityType: AUDIT_ENTITIES.TENANT_UPI_ACCOUNT,
        entityId: id,
        before,
        after,
      });

      return toUpiAccount(after);
    });
  }

  async removeUpiAccount(access: RequestAccess, id: string): Promise<void> {
    await this.repo.inTransaction(async (tx) => {
      const before = await this.repo.findUpiAccount(tx, access.tenantId, id);

      if (before === null)
        throw notFound('UPI account');

      await this.repo.softDeleteUpiAccount(tx, access.tenantId, id);

      // Removing the default would leave the tenant with handles but no chosen
      // one, so the oldest survivor takes it over rather than nothing at all.
      if (before.isDefault) {
        const heir = await this.repo.oldestLiveUpiAccount(tx, access.tenantId);

        if (heir !== null)
          await this.repo.updateUpiAccount(tx, access.tenantId, heir.id, { isDefault: true });
      }

      await audit.deleted(tx, access.audit, {
        entityType: AUDIT_ENTITIES.TENANT_UPI_ACCOUNT,
        entityId: id,
        before,
      });
    });
  }

  private async assertNotTheLastLiveOne(tenantId: string, id: string): Promise<void> {
    const live = await this.repo.listUpiAccounts(tenantId, true);

    if (live.length <= 1 && live[0]?.id === id)
      throw conflict('That is the only handle money can be collected into. Add another before standing this one down.');
  }

  private async insertOrConflict(
    tx: Transaction,
    tenantId: string,
    input: CreateUpiAccountBody & { isDefault: boolean },
  ): Promise<TenantUpiAccount> {
    try {
      return await this.repo.insertUpiAccount(tx, tenantId, input);
    }
    catch (error) {
      throw this.asDuplicate(error, input.upiId);
    }
  }

  private async updateOrConflict(
    tx: Transaction,
    tenantId: string,
    id: string,
    patch: UpdateUpiAccountBody,
  ): Promise<TenantUpiAccount> {
    try {
      return await this.repo.updateUpiAccount(tx, tenantId, id, patch);
    }
    catch (error) {
      throw this.asDuplicate(error, patch.upiId ?? '');
    }
  }

  /** The unique index is on `(tenant, vpa)`, so a clash is always the handle. */
  private asDuplicate(error: unknown, upiId: string): unknown {
    return isUniqueViolation(error)
      ? conflict(`${upiId} is already on this tenant`)
      : error;
  }
}

export { TenantService as TenantsService };

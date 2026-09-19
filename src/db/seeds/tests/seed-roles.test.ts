import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '@/config/constants';
import { rolePermissions, roles, tenantMemberships } from '@/db/schema';
import { ensureSystemRoles } from '@/db/seeds/seed-roles';
import { PERMISSIONS } from '@/security/permissions';
import { SYSTEM_ROLE_GRANTS } from '@/security/role-grants';
import { createTestDb } from '@/test/db';
import { snapshotRoleGrants } from '@/test/fixtures';

const { db, close } = createTestDb();
const ROLE_IDS = Object.keys(SYSTEM_ROLE_GRANTS);

let restore: () => Promise<void>;

beforeAll(async () => {
  // This file may be the first to touch the database, and it asserts on what
  // provisioning leaves behind — so start from a provisioned one.
  await ensureSystemRoles(db);
});

beforeEach(async () => {
  restore = await snapshotRoleGrants(db, ROLE_IDS);
});

afterAll(async () => {
  await ensureSystemRoles(db);
  await close();
});

async function grantsOf(roleId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ key: rolePermissions.permissionKey, scope: rolePermissions.scope })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));

  return new Map(rows.map(row => [row.key, row.scope]));
}

describe('provisioning the system roles', () => {
  it('creates all three from nothing, so a membership in a brand new tenant can resolve', async () => {
    // Emptying the role tables would break every membership in the shared test
    // database, so the empty-database case is played out inside a transaction
    // that is always rolled back.
    const seen: string[] = [];

    await expect(db.transaction(async (tx) => {
      await tx.delete(tenantMemberships);
      await tx.delete(rolePermissions);
      await tx.delete(roles);

      await ensureSystemRoles(tx);

      const present = await tx.select({ id: roles.id }).from(roles);
      seen.push(...present.map(row => row.id));

      throw new Error('rollback');
    })).rejects.toThrow('rollback');

    expect(seen.sort()).toEqual([...ROLE_IDS].sort());

    const stillThere = await db.select({ id: roles.id }).from(roles).where(inArray(roles.id, ROLE_IDS));
    expect(stillThere).toHaveLength(ROLE_IDS.length);
  });

  it('writes exactly the shipped matrix for every role', async () => {
    await ensureSystemRoles(db);

    for (const roleId of ROLE_IDS) {
      const actual = await grantsOf(roleId);
      const expected = new Map(SYSTEM_ROLE_GRANTS[roleId as keyof typeof SYSTEM_ROLE_GRANTS].map(([k, s]) => [k as string, s as string]));

      expect([...actual.entries()].sort()).toEqual([...expected.entries()].sort());
    }

    await restore();
  });

  it('revokes a grant that has been taken out of the matrix', async () => {
    // Stand in for a permission an earlier release granted and this one drops.
    await db.insert(rolePermissions)
      .values({ roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.PAYMENTS_DELETE, scope: 'ALL' })
      .onConflictDoNothing();

    expect((await grantsOf(SYSTEM_ROLES.STAFF)).has(PERMISSIONS.PAYMENTS_DELETE)).toBe(true);

    const { revoked } = await ensureSystemRoles(db);

    expect(revoked).toBeGreaterThan(0);
    expect((await grantsOf(SYSTEM_ROLES.STAFF)).has(PERMISSIONS.PAYMENTS_DELETE)).toBe(false);
    await restore();
  });

  it('narrows a scope that has been tightened in the matrix', async () => {
    await db.update(rolePermissions)
      .set({ scope: 'ALL' })
      .where(and(
        eq(rolePermissions.roleId, SYSTEM_ROLES.STAFF),
        eq(rolePermissions.permissionKey, PERMISSIONS.CUSTOMERS_VIEW),
      ));

    await ensureSystemRoles(db);

    expect((await grantsOf(SYSTEM_ROLES.STAFF)).get(PERMISSIONS.CUSTOMERS_VIEW)).toBe('LOCATION');
    await restore();
  });

  it('is safe to run twice', async () => {
    await ensureSystemRoles(db);
    const first = await grantsOf(SYSTEM_ROLES.STAFF);

    const second = await ensureSystemRoles(db);

    expect(second.revoked).toBe(0);
    expect([...(await grantsOf(SYSTEM_ROLES.STAFF)).entries()].sort()).toEqual([...first.entries()].sort());
    await restore();
  });
});

import type { TestDb } from './db';
import { randomInt, randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { SUPER_ADMIN_ROLE_ID, SYSTEM_ROLES } from '@/config/constants';
import { devices, rolePermissions, roles, tenantMemberships, tenants, users } from '@/db/schema';
import { hashPassword } from '@/shared/security/password';
import { ALL_PERMISSION_KEYS, PERMISSIONS } from '@/shared/security/permissions';

/**
 * Account and tenant shapes the auth flow has to tell apart (AGENTS.md §4).
 *
 * Every value is randomised: the suite runs in threads against ONE database, so
 * a fixed email or device id would make two files fight over a unique index.
 */

/** Unique, never a real number — `999` is not an allocated Indian mobile prefix. */
export function uniquePhone(): string {
  return `91999${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID()}@test.local`;
}

export function uniqueDeviceId(): string {
  return `device-${randomUUID()}`;
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export interface SeededAuthData {
  password: string;
  /** Email + password, member of both tenants with different roles. */
  active: { id: string; email: string; phone: string };
  /** Google-only: no password hash at all. */
  googleOnly: { id: string; email: string };
  /** `disabled_at` set — every session path must refuse it. */
  disabled: { id: string; email: string };
  /** Platform role via the flag, no membership anywhere. */
  superAdmin: { id: string; email: string };
  /** Phone with no account yet: verifying an OTP must create one. */
  unknownPhone: string;
  tenantA: { id: string; code: string };
  tenantB: { id: string; code: string };
  blockedDeviceId: string;
  cleanup: () => Promise<void>;
}

export async function seedRoles(db: TestDb): Promise<void> {
  const grants = {
    [SUPER_ADMIN_ROLE_ID]: ALL_PERMISSION_KEYS.map(key => [key, 'ALL'] as const),
    [SYSTEM_ROLES.ADMIN]: ALL_PERMISSION_KEYS.map(key => [key, 'ALL'] as const),
    [SYSTEM_ROLES.STAFF]: [[PERMISSIONS.CUSTOMERS_VIEW, 'AREA'] as const],
    [SYSTEM_ROLES.CUSTOMER]: [[PERMISSIONS.CUSTOMERS_VIEW, 'OWN'] as const],
  };

  for (const [roleId, permissions] of Object.entries(grants)) {
    await db.insert(roles)
      .values({ id: roleId, name: roleId, isSystem: true })
      .onConflictDoNothing();

    await db.insert(rolePermissions)
      .values(permissions.map(([permissionKey, scope]) => ({ roleId, permissionKey, scope })))
      .onConflictDoNothing();
  }
}

/**
 * `cleanup` removes exactly what this inserted — never a table-wide truncate,
 * which would delete rows another test file is using in parallel.
 */
export async function seedAuthData(db: TestDb): Promise<SeededAuthData> {
  await seedRoles(db);

  const passwordHash = await hashPassword(TEST_PASSWORD);
  const code = () => `T${randomUUID().slice(0, 4).toUpperCase()}`;

  const [tenantA] = await db.insert(tenants).values({ code: code(), name: 'Alpha Cable' }).returning();
  const [tenantB] = await db.insert(tenants).values({ code: code(), name: 'Beta Broadband' }).returning();

  const [active] = await db.insert(users)
    .values({ email: uniqueEmail('active'), phone: uniquePhone(), name: 'Active User', passwordHash })
    .returning();

  const [googleOnly] = await db.insert(users)
    .values({ email: uniqueEmail('google'), name: 'Google User', googleSub: `sub-${randomUUID()}` })
    .returning();

  const [disabled] = await db.insert(users)
    .values({ email: uniqueEmail('disabled'), name: 'Disabled User', passwordHash, disabledAt: new Date() })
    .returning();

  const [superAdmin] = await db.insert(users)
    .values({ email: uniqueEmail('super'), name: 'Super Admin', passwordHash, isSuperAdmin: true })
    .returning();

  // The same person, two tenants, two different roles — the case a `role`
  // column on `users` could not represent (§4.1).
  await db.insert(tenantMemberships).values([
    { userId: active!.id, tenantId: tenantA!.id, roleId: SYSTEM_ROLES.ADMIN },
    { userId: active!.id, tenantId: tenantB!.id, roleId: SYSTEM_ROLES.CUSTOMER },
  ]);

  // An inactive membership must not reach the token.
  await db.insert(tenantMemberships)
    .values({ userId: disabled!.id, tenantId: tenantA!.id, roleId: SYSTEM_ROLES.STAFF, status: 'suspended' });

  const [blocked] = await db.insert(devices)
    .values({ clientDeviceId: uniqueDeviceId(), platform: 'android', blockedAt: new Date() })
    .returning();

  const userIds = [active!.id, googleOnly!.id, disabled!.id, superAdmin!.id];

  return {
    password: TEST_PASSWORD,
    active: { id: active!.id, email: active!.email!, phone: active!.phone! },
    googleOnly: { id: googleOnly!.id, email: googleOnly!.email! },
    disabled: { id: disabled!.id, email: disabled!.email! },
    superAdmin: { id: superAdmin!.id, email: superAdmin!.email! },
    unknownPhone: uniquePhone(),
    tenantA: { id: tenantA!.id, code: tenantA!.code },
    tenantB: { id: tenantB!.id, code: tenantB!.code },
    blockedDeviceId: blocked!.clientDeviceId,
    cleanup: async () => {
      await db.delete(users).where(inArray(users.id, userIds));
      await db.delete(tenants).where(inArray(tenants.id, [tenantA!.id, tenantB!.id]));
      await db.delete(devices).where(inArray(devices.id, [blocked!.id]));
    },
  };
}

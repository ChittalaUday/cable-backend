import type { TestDb } from './db';
import { randomInt, randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { SYSTEM_ROLES } from '@/config/constants';
import { devices, rolePermissions, roles, tenantMemberships, tenants, users } from '@/db/schema';
import { hashPassword } from '@/security/password';
import { ALL_PERMISSION_KEYS, PERMISSIONS } from '@/security/permissions';
import { normaliseEmail } from '@/utils/email';

export function uniquePhone(): string {
  return `999${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
}

export function uniqueEmail(prefix = 'user'): string {
  // Canonical, because the column will not take anything else — a `prefix`
  // with a capital in it used to make an address nothing could sign in as.
  return normaliseEmail(`${prefix}-${randomUUID()}@test.local`)!;
}

export function uniqueDeviceId(): string {
  return `device-${randomUUID()}`;
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export interface SeededAuthData {
  password: string;
  active: { id: string; email: string; phone: string };
  googleOnly: { id: string; email: string };
  disabled: { id: string; email: string };
  other: { id: string; email: string };
  unknownPhone: string;
  tenantA: { id: string; code: string };
  tenantB: { id: string; code: string };
  blockedDeviceId: string;
  cleanup: () => Promise<void>;
}

export async function seedRoles(db: TestDb): Promise<void> {
  const grants = {
    [SYSTEM_ROLES.ADMIN]: ALL_PERMISSION_KEYS.map(key => [key, 'ALL'] as const),
    [SYSTEM_ROLES.STAFF]: [[PERMISSIONS.CUSTOMERS_VIEW, 'LOCATION'] as const],
    [SYSTEM_ROLES.CUSTOMER]: [[PERMISSIONS.CUSTOMERS_VIEW, 'OWN'] as const],
  };

  for (const [roleId, permissions] of Object.entries(grants)) {
    await db.insert(roles)
      .values({ id: roleId, name: roleId })
      .onConflictDoNothing();

    await db.insert(rolePermissions)
      .values(permissions.map(([permissionKey, scope]) => ({ roleId, permissionKey, scope })))
      .onConflictDoNothing();
  }
}

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

  const [other] = await db.insert(users)
    .values({ email: uniqueEmail('other'), name: 'Other User', passwordHash })
    .returning();

  await db.insert(tenantMemberships).values([
    { userId: active!.id, tenantId: tenantA!.id, roleId: SYSTEM_ROLES.ADMIN },
    { userId: active!.id, tenantId: tenantB!.id, roleId: SYSTEM_ROLES.CUSTOMER },
  ]);

  await db.insert(tenantMemberships)
    .values({ userId: disabled!.id, tenantId: tenantA!.id, roleId: SYSTEM_ROLES.STAFF, status: 'suspended' });

  const [blocked] = await db.insert(devices)
    .values({ clientDeviceId: uniqueDeviceId(), platform: 'android', blockedAt: new Date() })
    .returning();

  const userIds = [active!.id, googleOnly!.id, disabled!.id, other!.id];

  return {
    password: TEST_PASSWORD,
    active: { id: active!.id, email: active!.email!, phone: active!.phone! },
    googleOnly: { id: googleOnly!.id, email: googleOnly!.email! },
    disabled: { id: disabled!.id, email: disabled!.email! },
    other: { id: other!.id, email: other!.email! },
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

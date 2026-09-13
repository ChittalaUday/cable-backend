import type { SeedRoleId } from '@/config/constants';
import type { PermissionKey, PermissionScope } from '@/shared/security/permissions';
/**
 * `pnpm db:seed`. Safe to re-run.
 *
 * Every account but one is created through the API. The super admin is the
 * exception — `users.create` needs a caller who already holds it — so its
 * credentials come from `SUPER_ADMIN_*` and are never committed here.
 */
import process from 'node:process';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { SUPER_ADMIN_ROLE_ID, SYSTEM_ROLES } from '@/config/constants';
import { env } from '@/config/env';
import { rolePermissions, roles, tenants, users } from '@/db/schema';
import { hashPassword } from '@/shared/security/password';
import {
  ALL_PERMISSION_KEYS,

  PERMISSIONS,

} from '@/shared/security/permissions';

const EVERYTHING = ALL_PERMISSION_KEYS.map(key => [key, 'ALL'] as [PermissionKey, PermissionScope]);

/**
 * `super_admin` and `admin` both hold the whole catalogue at ALL; what separates
 * them is the tenant boundary, not the grants (§5) — `super_admin` crosses it,
 * `admin` is confined to their own tenant by stage 2.
 */
const GRANTS: Record<SeedRoleId, Array<[PermissionKey, PermissionScope]>> = {
  [SUPER_ADMIN_ROLE_ID]: EVERYTHING,

  [SYSTEM_ROLES.ADMIN]: EVERYTHING,

  [SYSTEM_ROLES.STAFF]: [
    [PERMISSIONS.CUSTOMERS_VIEW, 'AREA'],
    [PERMISSIONS.CUSTOMERS_CREATE, 'AREA'],
    [PERMISSIONS.CUSTOMERS_UPDATE, 'AREA'],
    [PERMISSIONS.CONNECTIONS_VIEW, 'AREA'],
    [PERMISSIONS.CONNECTIONS_CREATE, 'AREA'],
    [PERMISSIONS.CONNECTIONS_UPDATE, 'AREA'],
    [PERMISSIONS.PAYMENTS_VIEW, 'AREA'],
    [PERMISSIONS.PAYMENTS_COLLECT, 'AREA'],
    [PERMISSIONS.TICKETS_VIEW, 'ASSIGNED'],
    [PERMISSIONS.TICKETS_CREATE, 'AREA'],
    [PERMISSIONS.TICKETS_UPDATE, 'ASSIGNED'],
    [PERMISSIONS.TICKETS_RESOLVE, 'ASSIGNED'],
    [PERMISSIONS.INVENTORY_VIEW, 'ASSIGNED'],
    [PERMISSIONS.INVENTORY_UPDATE, 'ASSIGNED'],
    [PERMISSIONS.PACKAGES_VIEW, 'ALL'],
    [PERMISSIONS.SERVICES_VIEW, 'ALL'],
    [PERMISSIONS.REPORTS_VIEW, 'AREA'],
  ],

  [SYSTEM_ROLES.CUSTOMER]: [
    [PERMISSIONS.CUSTOMERS_VIEW, 'OWN'],
    [PERMISSIONS.CONNECTIONS_VIEW, 'OWN'],
    [PERMISSIONS.PAYMENTS_VIEW, 'OWN'],
    [PERMISSIONS.TICKETS_VIEW, 'OWN'],
    [PERMISSIONS.TICKETS_CREATE, 'OWN'],
    [PERMISSIONS.PACKAGES_VIEW, 'ALL'],
    [PERMISSIONS.SERVICES_VIEW, 'ALL'],
    [PERMISSIONS.DEVICES_VIEW, 'OWN'],
    [PERMISSIONS.SESSIONS_VIEW, 'OWN'],
    [PERMISSIONS.SESSIONS_REVOKE, 'OWN'],
  ],
};

const ROLE_NAMES: Record<SeedRoleId, string> = {
  [SUPER_ADMIN_ROLE_ID]: 'Super Admin',
  [SYSTEM_ROLES.ADMIN]: 'Admin',
  [SYSTEM_ROLES.STAFF]: 'Staff',
  [SYSTEM_ROLES.CUSTOMER]: 'Customer',
};

const TENANTS = [
  { code: 'SCB', name: 'Satya Cable & Broadband' },
  { code: 'NCB', name: 'Nova Cable Network' },
];

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
const db = drizzle(pool);

const MIN_SUPER_ADMIN_PASSWORD = 12;

async function seedSuperAdmin() {
  const email = env.SUPER_ADMIN_EMAIL.trim().toLowerCase();
  const password = env.SUPER_ADMIN_PASSWORD;

  if (!email || !password) {
    console.log('ℹ️  SUPER_ADMIN_EMAIL/PASSWORD unset — skipping super admin');
    return;
  }

  // Loud, not silent: a weak password on this account defeats every other check.
  if (password.length < MIN_SUPER_ADMIN_PASSWORD)
    throw new Error(`SUPER_ADMIN_PASSWORD must be at least ${MIN_SUPER_ADMIN_PASSWORD} characters`);

  const passwordHash = await hashPassword(password);
  const name = env.SUPER_ADMIN_NAME;

  await db
    .insert(users)
    .values({ email, name, passwordHash, isSuperAdmin: true })
    .onConflictDoUpdate({
      target: users.email,
      // Re-running with a changed password rotates it, and bumping
      // `credentials_changed_at` revokes every session issued before (§4.6).
      set: { name, passwordHash, isSuperAdmin: true, credentialsChangedAt: new Date(), updatedAt: new Date() },
    });

  console.log(`   super admin: ${email}`);
}

try {
  // Keyed off GRANTS, not SYSTEM_ROLES, so `super_admin` is included — it is a
  // real role row even though no membership may reference it.
  for (const roleId of Object.keys(GRANTS) as SeedRoleId[]) {
    await db
      .insert(roles)
      .values({ id: roleId, name: ROLE_NAMES[roleId], isSystem: true, tenantId: null })
      .onConflictDoUpdate({ target: roles.id, set: { name: ROLE_NAMES[roleId], updatedAt: new Date() } });

    await db
      .insert(rolePermissions)
      .values(GRANTS[roleId].map(([permissionKey, scope]) => ({ roleId, permissionKey, scope })))
      .onConflictDoUpdate({
        target: [rolePermissions.roleId, rolePermissions.permissionKey],
        set: { scope: sql`excluded.scope` },
      });
  }

  await seedSuperAdmin();

  // DoNothing, not an upsert: `customer_seq` is a live counter (§8.1).
  await db.insert(tenants).values(TENANTS).onConflictDoNothing({ target: tenants.code });

  console.log(`✅ Seeded ${Object.keys(GRANTS).length} roles, ${TENANTS.length} tenants`);
}
catch (error) {
  console.error('❌ Seed failed:', error);
  process.exitCode = 1;
}
finally {
  await pool.end();
}

import type { SystemRoleId } from '@/config/constants';
import type { PermissionKey, PermissionScope } from '@/shared/security/permissions';
/**
 * `pnpm db:seed`. Safe to re-run.
 *
 * Accounts are created through the API; this seeder installs fixed roles,
 * permission grants, and initial tenants only.
 */
import process from 'node:process';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { SYSTEM_ROLES } from '@/config/constants';
import { env } from '@/config/env';
import { rolePermissions, roles, tenants } from '@/db/schema';
import {
  ALL_PERMISSION_KEYS,

  PERMISSIONS,

} from '@/shared/security/permissions';

const EVERYTHING = ALL_PERMISSION_KEYS.map(key => [key, 'ALL'] as [PermissionKey, PermissionScope]);

/**
 * Admin holds the whole catalogue at ALL but remains confined to its tenant.
 */
const GRANTS: Record<SystemRoleId, Array<[PermissionKey, PermissionScope]>> = {
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

const ROLE_NAMES: Record<SystemRoleId, string> = {
  [SYSTEM_ROLES.ADMIN]: 'Admin',
  [SYSTEM_ROLES.STAFF]: 'Staff',
  [SYSTEM_ROLES.CUSTOMER]: 'Customer',
};

const TENANTS = [
  { code: 'SSCN', name: 'Sri Satya Cable Network' },
  { code: 'NCB', name: 'Nova Cable Network' },
];

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
const db = drizzle(pool);

try {
  for (const roleId of Object.keys(GRANTS) as SystemRoleId[]) {
    await db
      .insert(roles)
      .values({ id: roleId, name: ROLE_NAMES[roleId] })
      .onConflictDoUpdate({ target: roles.id, set: { name: ROLE_NAMES[roleId], updatedAt: new Date() } });

    await db
      .insert(rolePermissions)
      .values(GRANTS[roleId].map(([permissionKey, scope]) => ({ roleId, permissionKey, scope })))
      .onConflictDoUpdate({
        target: [rolePermissions.roleId, rolePermissions.permissionKey],
        set: { scope: sql`excluded.scope` },
      });
  }

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

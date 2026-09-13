import type { SystemRoleId } from '@/config/constants';
import type { PermissionKey, PermissionScope } from '@/shared/security/permissions';
import process from 'node:process';
import { eq, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { SYSTEM_ROLES } from '@/config/constants';
import { env } from '@/config/env';
import * as schema from '@/db/schema';
import { rolePermissions, roles, tenantMemberships, tenants, users } from '@/db/schema';
import { hashPassword } from '@/shared/security/password';
import {
  ALL_PERMISSION_KEYS,
  PERMISSIONS,
} from '@/shared/security/permissions';
import { seedLocations } from './seed-locations';

const EVERYTHING = ALL_PERMISSION_KEYS.map(key => [key, 'ALL'] as [PermissionKey, PermissionScope]);

const GRANTS: Record<SystemRoleId, Array<[PermissionKey, PermissionScope]>> = {
  [SYSTEM_ROLES.ADMIN]: EVERYTHING,

  [SYSTEM_ROLES.STAFF]: [
    [PERMISSIONS.CUSTOMERS_VIEW, 'AREA'],
    [PERMISSIONS.CUSTOMERS_CREATE, 'AREA'],
    [PERMISSIONS.CUSTOMERS_UPDATE, 'AREA'],
    // The tree itself at AREA: staff see the subtrees their membership grants,
    // and a node they add lands as `pending` for review (§8.6). Not
    // LOCATIONS_CONFIGURE — defining levels is admin work.
    [PERMISSIONS.LOCATIONS_VIEW, 'AREA'],
    [PERMISSIONS.LOCATIONS_CREATE, 'AREA'],
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
    // Deliberately no locations.*: a subscriber reads their own address off
    // their own record, not by browsing the operator's tree.
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
const db = drizzle(pool, { schema });

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

  await db.insert(tenants).values(TENANTS).onConflictDoNothing({ target: tenants.code });

  console.log(`✅ Seeded ${Object.keys(GRANTS).length} roles, ${TENANTS.length} tenants`);

  const allTenants = await db.select().from(tenants);
  const tenantMap = new Map(allTenants.map(t => [t.code, t.id]));

  const ADMIN_PASSWORD = 'Admin@123456';

  const ADMIN_ACCOUNTS = [
    {
      name: 'SSCN Admin',
      email: 'admin@sscn.com',
      phone: '9999900001',
      password: ADMIN_PASSWORD,
      tenantCodes: ['SSCN'],
    },
    {
      name: 'NCB Admin',
      email: 'admin@ncb.com',
      phone: '9999900002',
      password: ADMIN_PASSWORD,
      tenantCodes: ['NCB'],
    },
    {
      name: 'Uday Super Admin',
      email: 'uday@sscn.com',
      phone: '8309154716',
      password: ADMIN_PASSWORD,
      tenantCodes: ['SSCN', 'NCB'],
    },
  ];

  for (const admin of ADMIN_ACCOUNTS) {
    const passwordHash = await hashPassword(admin.password);

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(or(
        eq(users.email, admin.email),
        eq(users.phone, admin.phone),
      ));

    let userId: string;
    if (existing) {
      await db
        .update(users)
        .set({
          name: admin.name,
          email: admin.email,
          phone: admin.phone,
          passwordHash,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id));
      userId = existing.id;
    }
    else {
      const [inserted] = await db
        .insert(users)
        .values({
          name: admin.name,
          email: admin.email,
          phone: admin.phone,
          passwordHash,
        })
        .returning({ id: users.id });
      userId = inserted!.id;
    }

    for (const code of admin.tenantCodes) {
      const tenantId = tenantMap.get(code);
      if (tenantId === undefined)
        continue;

      await db
        .insert(tenantMemberships)
        .values({
          userId,
          tenantId,
          roleId: SYSTEM_ROLES.ADMIN,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [tenantMemberships.userId, tenantMemberships.tenantId],
          set: {
            roleId: SYSTEM_ROLES.ADMIN,
            status: 'active',
            updatedAt: new Date(),
          },
        });
    }
  }

  console.log(`✅ Seeded admin accounts for ${ADMIN_ACCOUNTS.length} users`);

  const sscnTenantId = tenantMap.get('SSCN');
  if (sscnTenantId !== undefined) {
    await seedLocations(db, sscnTenantId);
  }
}
catch (error) {
  console.error('❌ Seed failed:', error);
  process.exitCode = 1;
}
finally {
  await pool.end();
}

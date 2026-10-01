import process from 'node:process';
import { and, eq, isNull, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { SYSTEM_ROLES } from '@/config/constants';
import { env } from '@/config/env';
import * as schema from '@/db/schema';
import { tenantMemberships, tenants, tenantUpiAccounts, users } from '@/db/schema';
import { hashPassword } from '@/security/password';
import { SYSTEM_ROLE_GRANTS } from '@/security/role-grants';
import { seedLocations } from './seed-locations';
import { seedRemotes } from './seed-remotes';
import { ensureSystemRoles } from './seed-roles';
import { seedStaff } from './seed-staff';

const TENANTS = [
  { code: 'SSCN', name: 'Sri Satya Cable Network' },
  { code: 'NCB', name: 'Nova Cable Network' },
];

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
const db = drizzle(pool, { schema });

try {
  const { granted, revoked } = await ensureSystemRoles(db);

  await db.insert(tenants).values(TENANTS).onConflictDoNothing({ target: tenants.code });

  console.log(
    `✅ Seeded ${Object.keys(SYSTEM_ROLE_GRANTS).length} roles (${granted} grants`
    + `${revoked > 0 ? `, ${revoked} revoked` : ''}), ${TENANTS.length} tenants`,
  );

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
    const upiId = '9951179664@ybl';
    const [existingUpi] = await db.select({ id: tenantUpiAccounts.id })
      .from(tenantUpiAccounts)
      .where(and(
        eq(tenantUpiAccounts.tenantId, sscnTenantId),
        eq(tenantUpiAccounts.upiId, upiId),
        isNull(tenantUpiAccounts.deletedAt),
      ));

    await db.transaction(async (tx) => {
      await tx.update(tenantUpiAccounts)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(tenantUpiAccounts.tenantId, sscnTenantId));

      if (existingUpi === undefined) {
        await tx.insert(tenantUpiAccounts).values({
          tenantId: sscnTenantId,
          upiId,
          payeeName: 'Sri Satya Cable Network',
          label: 'Primary QR',
          isDefault: true,
        });
      }
      else {
        await tx.update(tenantUpiAccounts)
          .set({ isDefault: true, status: 'active', updatedAt: new Date() })
          .where(eq(tenantUpiAccounts.id, existingUpi.id));
      }
    });

    await seedLocations(db, sscnTenantId);
    await seedStaff(db, sscnTenantId);
  }

  const remoteCount = await seedRemotes(db);
  console.log(`✅ Seeded ${remoteCount} IR remotes into the shared library`);
}
catch (error) {
  console.error('❌ Seed failed:', error);
  process.exitCode = 1;
}
finally {
  await pool.end();
}

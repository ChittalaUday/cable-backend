/**
 * Gives N existing customers a login, so a load test can hold N distinct
 * sessions. The response cache keys on the caller (`scopeIdFor`), so one
 * account would only ever prove that one cache entry is fast.
 *
 * Idempotent: the same N customers get the same N e-mail addresses every run.
 *
 *   pnpm stress:seed                      # 300 customers in SSCN
 *   pnpm stress:seed --count=50
 *   pnpm stress:seed --purge              # remove every load-test login
 */
import process from 'node:process';
import { and, asc, eq, isNull, like, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { SYSTEM_ROLES } from '@/config/constants';
import { env } from '@/config/env';
import * as schema from '@/db/schema';
import { customers, tenantMemberships, tenants, users } from '@/db/schema';
import { hashPassword } from '@/security/password';
import { arg, flag, STRESS_EMAIL_DOMAIN, STRESS_PASSWORD, STRESS_TENANT_CODE, stressEmail } from './shared';

const COUNT = Number(arg('count', '300'));
const TENANT_CODE = arg('tenant', STRESS_TENANT_CODE);
const EMAIL_LIKE = `%@${STRESS_EMAIL_DOMAIN}`;

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
const db = drizzle(pool, { schema });

try {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.code, TENANT_CODE));
  if (tenant === undefined)
    throw new Error(`No tenant with code ${TENANT_CODE}. Run pnpm db:seed first.`);

  if (flag('purge')) {
    // customers.user_id is ON DELETE SET NULL and memberships cascade, so the
    // users row is the only thing that has to go.
    const gone = await db.delete(users).where(like(users.email, EMAIL_LIKE)).returning({ id: users.id });
    console.log(`🧹 Removed ${gone.length} load-test login(s).`);
    process.exit(0);
  }

  const picked = await db
    .select({ id: customers.id, code: customers.customerCode, name: customers.name })
    .from(customers)
    .where(and(eq(customers.tenantId, tenant.id), isNull(customers.deletedAt)))
    .orderBy(asc(customers.createdAt), asc(customers.id))
    .limit(COUNT);

  if (picked.length === 0)
    throw new Error(`Tenant ${TENANT_CODE} has no customers to give logins to.`);

  if (picked.length < COUNT)
    console.warn(`⚠️  Only ${picked.length} customers exist — seeding that many instead of ${COUNT}.`);

  // One hash, reused. Argon2 salts inside the hash, so 300 calls would cost
  // ~15s to produce 300 fixtures that all share the same password anyway.
  const passwordHash = await hashPassword(STRESS_PASSWORD);

  const rows = picked.map((customer, index) => ({
    customerId: customer.id,
    email: stressEmail(index),
    name: customer.name ?? customer.code ?? `Load Test ${index + 1}`,
    passwordHash,
  }));

  const inserted = await db
    .insert(users)
    .values(rows.map(({ email, name, passwordHash: hash }) => ({ email, name, passwordHash: hash })))
    .onConflictDoUpdate({
      target: users.email,
      set: { name: sql`excluded.name`, passwordHash: sql`excluded.password_hash`, updatedAt: new Date() },
    })
    .returning({ id: users.id, email: users.email });

  const userIdByEmail = new Map(inserted.map(u => [u.email, u.id]));

  await db
    .insert(tenantMemberships)
    .values(inserted.map(u => ({
      userId: u.id,
      tenantId: tenant.id,
      roleId: SYSTEM_ROLES.CUSTOMER,
      status: 'active' as const,
    })))
    .onConflictDoUpdate({
      target: [tenantMemberships.userId, tenantMemberships.tenantId],
      set: { roleId: SYSTEM_ROLES.CUSTOMER, status: 'active', updatedAt: new Date() },
    });

  // `/auth/me` resolves the customer profile off this link, and CUSTOMERS_VIEW
  // at OWN scope has nothing to match on without it.
  for (const row of rows) {
    const userId = userIdByEmail.get(row.email);
    if (userId !== undefined)
      await db.update(customers).set({ userId, updatedAt: new Date() }).where(eq(customers.id, row.customerId));
  }

  console.log(`✅ ${rows.length} customer logins ready in ${TENANT_CODE}`);
  console.log(`   ${stressEmail(0)} … ${stressEmail(rows.length - 1)}`);
  console.log(`   password: ${STRESS_PASSWORD}`);
}
catch (error) {
  console.error('❌ Seed failed:', error);
  process.exitCode = 1;
}
finally {
  await pool.end();
}

import type { BuiltApp } from '@/app';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { accountTransactions, customers, membershipLocations, rolePermissions, subscriptions, teams, tenantMemberships, users } from '@/db/schema';
import { hashPassword } from '@/security/password';
import { PERMISSIONS } from '@/security/permissions';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();
const unique = () => randomUUID().slice(0, 8);
let app: BuiltApp;
let auth: Record<string, string>;
let staffAuth: Record<string, string>;
let cleanup: () => Promise<void>;
let tenantId: string;
let areaId: string;
let schemaId: string;
let providerId: string;
let packageId: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const data = await seedAuthData(db);
  cleanup = data.cleanup;
  tenantId = data.tenantA.id;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: data.active.email, password: TEST_PASSWORD },
  });
  auth = { 'authorization': `Bearer ${bodyOf(login).accessToken}`, 'x-tenant-id': data.tenantA.id };

  await db.insert(rolePermissions).values({ roleId: 'staff', permissionKey: PERMISSIONS.REPORTS_VIEW, scope: 'LOCATION' }).onConflictDoUpdate({
    target: [rolePermissions.roleId, rolePermissions.permissionKey],
    set: { scope: 'LOCATION' },
  });

  const write = { ...auth, 'content-type': 'application/json' };
  const service = bodyOf<{ id: string }>(await app.inject({ method: 'POST', url: '/api/v1/services', headers: write, payload: { name: 'Cable', slug: `cable-${randomUUID()}` } }));
  const provider = bodyOf<{ id: string }>(await app.inject({ method: 'POST', url: '/api/v1/service-providers', headers: write, payload: { serviceId: service.id, name: 'Provider', slug: `provider-${randomUUID()}` } }));
  const pkg = bodyOf<{ id: string }>(await app.inject({ method: 'POST', url: '/api/v1/packages', headers: write, payload: { serviceProviderId: provider.id, name: 'Base', slug: `base-${randomUUID()}`, price: '350.00' } }));
  const category = bodyOf<{ id: string }>(await app.inject({ method: 'POST', url: '/api/v1/location-categories', headers: write, payload: { name: 'Area', slug: `area-${randomUUID()}` } }));
  const schema = bodyOf<{ id: string }>(await app.inject({ method: 'POST', url: '/api/v1/location-schemas', headers: write, payload: { name: 'Flat', slug: `flat-${randomUUID()}`, levels: [{ categoryId: category.id }] } }));
  const location = bodyOf<{ id: string }>(await app.inject({ method: 'POST', url: '/api/v1/locations', headers: write, payload: { schemaId: schema.id, name: 'North' } }));
  areaId = location.id;
  schemaId = schema.id;
  providerId = provider.id;
  packageId = pkg.id;

  const [team] = await db.insert(teams).values({ tenantId: data.tenantA.id, name: 'Collections', slug: `collections-${randomUUID()}` }).returning();
  const [staff, teammate] = await db.insert(users).values([
    { email: uniqueEmail('collector'), phone: uniquePhone(), name: 'Collector', passwordHash: await hashPassword(TEST_PASSWORD) },
    { email: uniqueEmail('teammate'), phone: uniquePhone(), name: 'Teammate', passwordHash: await hashPassword(TEST_PASSWORD) },
  ]).returning();
  const [membership] = await db.insert(tenantMemberships).values([
    { userId: staff!.id, tenantId: data.tenantA.id, roleId: 'staff', teamId: team!.id },
    { userId: teammate!.id, tenantId: data.tenantA.id, roleId: 'staff', teamId: team!.id },
  ]).returning();
  await db.insert(membershipLocations).values({ membershipId: membership!.id, locationId: location.id });

  const [customer] = await db.insert(customers).values({
    tenantId: data.tenantA.id,
    name: 'Live Customer',
    phone: uniquePhone(),
    status: 'active',
    outstandingBalance: '125.00',
  }).returning();
  await db.insert(subscriptions).values({
    tenantId: data.tenantA.id,
    customerId: customer!.id,
    serviceProviderId: provider.id,
    packageId: pkg.id,
    serviceAccountNumber: 'ACC-LIVE',
    installationLocationId: location.id,
    status: 'active',
    price: '350.00',
  });
  const transaction = (collectedBy: string, credit: string) => ({
    tenantId: data.tenantA.id,
    serviceId: service.id,
    customerId: customer!.id,
    serviceAccountNumber: 'ACC-LIVE',
    transactionNo: randomUUID(),
    transactionDate: new Date(),
    transactionType: 'deposit' as const,
    credit,
    collectedBy,
  });
  await db.insert(accountTransactions).values([transaction(staff!.id, '500.00'), transaction(teammate!.id, '300.00')]);

  const staffLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'android' },
    payload: { identifier: staff!.email, password: TEST_PASSWORD },
  });
  staffAuth = { 'authorization': `Bearer ${bodyOf(staffLogin).accessToken}`, 'x-tenant-id': data.tenantA.id };
});

afterAll(async () => {
  await app.close();
  await cleanup();
  await close();
});

describe('analytics dashboards', () => {
  it('returns tenant-wide admin values from live records', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/analytics/admin-dashboard', headers: auth });

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      customers: { total: 1, active: 1, inactive: 0, pending: 0 },
      connections: { total: 1, active: 1, inactive: 0, suspended: 0, cancelled: 0 },
      collections: { today: '800.00', week: '800.00', month: '800.00' },
      outstanding: { amount: '125.00', accounts: 1 },
    });
    expect(bodyOf<{ services: { label: string; count: number }[] }>(response).services).toContainEqual(expect.objectContaining({ label: 'Cable', count: 1 }));
  });

  it('does not expose the staff dashboard to an admin', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/analytics/staff-dashboard', headers: auth });
    expect(response.statusCode).toBe(403);
  });

  it('does not expose the admin dashboard to staff', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/analytics/admin-dashboard', headers: staffAuth });
    expect(response.statusCode).toBe(403);
  });

  it('counts exactly the customers the customers list shows', async () => {
    const settleCache = async () => {
      const bump = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: { schemaId, name: `Cache Bump ${unique()}` },
      });
      expect(bump.statusCode, bump.body).toBe(201);
    };

    const countBoth = async () => {
      await settleCache();

      const dashboard = await app.inject({ method: 'GET', url: '/api/v1/analytics/staff-dashboard', headers: staffAuth });
      const list = await app.inject({ method: 'GET', url: '/api/v1/customers?limit=100', headers: staffAuth });

      expect(dashboard.statusCode, dashboard.body).toBe(200);
      expect(list.statusCode, list.body).toBe(200);

      return {
        workload: bodyOf<{ workload: { customers: number } }>(dashboard).workload.customers,
        listed: bodyOf<{ total: number }>(list).total,
      };
    };

    const before = await countBoth();
    expect(before.workload).toBe(before.listed);

    const [lineOnly] = await db.insert(customers).values({
      tenantId,
      name: 'Reachable Only By Line',
      phone: uniquePhone(),
      status: 'active',
    }).returning();

    try {
      await db.insert(subscriptions).values({
        tenantId,
        customerId: lineOnly!.id,
        serviceProviderId: providerId,
        packageId,
        serviceAccountNumber: `ACC-${randomUUID().slice(0, 8)}`,
        installationLocationId: areaId,
        status: 'active',
      });

      const after = await countBoth();

      expect(after.workload).toBe(after.listed);
      expect(after.workload).toBe(before.workload + 1);
    }
    finally {
      await db.delete(subscriptions).where(eq(subscriptions.customerId, lineOnly!.id));
      await db.delete(customers).where(eq(customers.id, lineOnly!.id));
      await settleCache();
    }
  });

  it('separates personal collection status from team status', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/analytics/staff-dashboard', headers: staffAuth });
    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      personal: { today: '500.00', month: '500.00', todayReceipts: 1 },
      team: { today: '800.00', month: '800.00', todayReceipts: 2 },
      workload: { customers: 1, dueCustomers: 1, outstanding: '125.00', activeConnections: 1, inactiveConnections: 0 },
    });
  });
});

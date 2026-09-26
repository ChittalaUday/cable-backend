import type { BuiltApp } from '@/app';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import {
  customers,
  itemCatalog,
  locationCategories,
  locations,
  locationSchemas,
  membershipLocations,
  packages,
  rolePermissions,
  serviceProviders,
  services,
  subscriptions,
  tenantMemberships,
  users,
} from '@/db/schema';
import { hashPassword } from '@/security/password';
import { PERMISSIONS } from '@/security/permissions';
import { createTestDb } from '@/test/db';
import { releaseUserReferences, seedAuthData, snapshotRoleGrants, TEST_PASSWORD, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { as, signIn } from '@/test/http';

const { db, close } = createTestDb();
const unique = () => randomUUID().slice(0, 8);

let app: BuiltApp;
let cleanup: () => Promise<void>;
let tenantId: string;

let adminAuth: Record<string, string>;
let staffAuth: Record<string, string>;
let staffMembershipId: string;
let restoreGrants: () => Promise<void>;

const north = { id: '', customerId: '', name: '' };
const south = { id: '', customerId: '', name: '' };
let catalogId: string;
let providerId: string;
let serviceId: string;

const createdUserIds: string[] = [];

interface Cached { cache: string | undefined; body: unknown }

async function get(url: string, headers: Record<string, string>): Promise<Cached> {
  const response = await app.inject({ method: 'GET', url, headers });
  expect(response.statusCode, response.body).toBe(200);

  return { cache: response.headers['x-cache'] as string | undefined, body: response.json() };
}

/** Read twice so the second is served from Redis, and prove it was. */
async function warm(url: string, headers: Record<string, string>): Promise<void> {
  await get(url, headers);
  expect((await get(url, headers)).cache).toBe('HIT');
}

async function post(url: string, headers: Record<string, string>, payload: unknown) {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: payload as never,
  });
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response;
}

async function patch(url: string, headers: Record<string, string>, payload: unknown) {
  const response = await app.inject({
    method: 'PATCH',
    url,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: payload as never,
  });
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response;
}

async function put(url: string, headers: Record<string, string>, payload: unknown) {
  const response = await app.inject({
    method: 'PUT',
    url,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: payload as never,
  });
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const data = await seedAuthData(db);
  cleanup = data.cleanup;
  tenantId = data.tenantA.id;
  adminAuth = as(await signIn(app, data.active.email), tenantId);

  restoreGrants = await snapshotRoleGrants(db, [SYSTEM_ROLES.STAFF]);
  await db.insert(rolePermissions).values([
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.CUSTOMERS_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.LOCATIONS_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.INVENTORY_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.PACKAGES_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.SERVICES_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.PAYMENTS_COLLECT, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.PAYMENTS_VIEW, scope: 'LOCATION' as const },
  ]).onConflictDoUpdate({
    target: [rolePermissions.roleId, rolePermissions.permissionKey],
    set: { scope: 'LOCATION' },
  });

  const [category] = await db.insert(locationCategories)
    .values({ tenantId, name: 'Area', slug: `area-${unique()}` })
    .returning();
  const [schema] = await db.insert(locationSchemas)
    .values({ tenantId, name: 'Flat', slug: `flat-${unique()}` })
    .returning();

  const node = async (name: string) => {
    const [row] = await db.insert(locations)
      .values({ tenantId, schemaId: schema!.id, categoryId: category!.id, name })
      .returning();
    return row!.id;
  };

  north.name = `North ${unique()}`;
  south.name = `South ${unique()}`;
  north.id = await node(north.name);
  south.id = await node(south.name);

  const [service] = await db.insert(services)
    .values({ tenantId, name: 'Cable TV', slug: `cable-${unique()}` })
    .returning();
  serviceId = service!.id;
  const [provider] = await db.insert(serviceProviders)
    .values({ tenantId, serviceId, name: 'ACT', slug: `act-${unique()}` })
    .returning();
  providerId = provider!.id;
  const [pkg] = await db.insert(packages)
    .values({ tenantId, serviceProviderId: providerId, name: `Base ${unique()}`, slug: `base-${unique()}`, price: '300.00' })
    .returning();
  const [catalog] = await db.insert(itemCatalog)
    .values({ tenantId, name: 'Set Top Box', code: `STB-${unique()}` })
    .returning();
  catalogId = catalog!.id;

  const customer = async (name: string, locationId: string) => {
    const [row] = await db.insert(customers)
      .values({ tenantId, name, phone: uniquePhone(), customerCode: `C${unique().toUpperCase()}` })
      .returning();
    await db.insert(subscriptions).values({
      tenantId,
      customerId: row!.id,
      installationLocationId: locationId,
      serviceProviderId: providerId,
      packageId: pkg!.id,
      serviceAccountNumber: `SA-${unique()}`,
    });
    return row!.id;
  };

  north.customerId = await customer('North Customer', north.id);
  south.customerId = await customer('South Customer', south.id);

  const email = uniqueEmail('cache-staff');
  const [staff] = await db.insert(users).values({
    email,
    phone: uniquePhone(),
    name: 'Field Engineer',
    passwordHash: await hashPassword(TEST_PASSWORD),
  }).returning();
  createdUserIds.push(staff!.id);

  const [membership] = await db.insert(tenantMemberships)
    .values({ userId: staff!.id, tenantId, roleId: SYSTEM_ROLES.STAFF })
    .returning();
  staffMembershipId = membership!.id;

  await db.insert(membershipLocations).values({ membershipId: staffMembershipId, locationId: north.id });
  staffAuth = as(await signIn(app, email), tenantId);
});

afterAll(async () => {
  await app.close();
  await restoreGrants();
  await releaseUserReferences(db, createdUserIds);
  await db.delete(users).where(inArray(users.id, createdUserIds));
  await cleanup();
  await close();
});

const CUSTOMERS = '/api/v1/customers?limit=100';
const ids = (body: unknown) => (body as { items: { id: string }[] }).items.map(row => row.id);

describe('a grant change reaches a reader who is already holding a cached page', () => {
  it('re-filters the customer list the moment an admin moves the engineer to another area', async () => {
    await warm(CUSTOMERS, staffAuth);

    const before = await get(CUSTOMERS, staffAuth);
    expect(ids(before.body)).toContain(north.customerId);
    expect(ids(before.body)).not.toContain(south.customerId);

    // The engineer is reassigned mid-session.
    await put(`/api/v1/staff/${staffMembershipId}/locations`, adminAuth, { locationIds: [south.id] });

    const after = await get(CUSTOMERS, staffAuth);

    expect(after.cache).not.toBe('HIT');
    expect(ids(after.body)).toContain(south.customerId);
    expect(ids(after.body)).not.toContain(north.customerId);
  });

  it('keeps the new page cached until something else moves', async () => {
    await warm(CUSTOMERS, staffAuth);
  });
});

describe('a change in another module reaches a cached reader', () => {
  it('shows equipment issued by someone else on the next customer read', async () => {
    // Put the engineer back where the fixtures left them.
    await put(`/api/v1/staff/${staffMembershipId}/locations`, adminAuth, { locationIds: [north.id] });
    await warm(CUSTOMERS, adminAuth);

    await post('/api/v1/inventory/issue', adminAuth, {
      customerId: north.customerId,
      catalogId,
      serialNumber: `SN-${unique()}`,
    });

    const after = await get(CUSTOMERS, adminAuth);

    expect(after.cache).not.toBe('HIT');
    const row = (after.body as { items: { id: string; equipment: unknown[] }[] })
      .items
      .find(item => item.id === north.customerId);
    expect(row?.equipment.length).toBeGreaterThan(0);
  });

  it('re-renders the breadcrumb on a customer row when the area is renamed', async () => {
    await warm(CUSTOMERS, adminAuth);

    const renamed = `North Renamed ${unique()}`;
    await patch(`/api/v1/locations/${north.id}`, adminAuth, { name: renamed });

    const after = await get(CUSTOMERS, adminAuth);

    expect(after.cache).not.toBe('HIT');
    const row = (after.body as { items: { id: string; locationPath: string | null }[] })
      .items
      .find(item => item.id === north.customerId);
    expect(row?.locationPath).toContain(renamed);
    north.name = renamed;
  });

  it('re-renders coverageAreas on the package list when the area is renamed', async () => {
    await put(`/api/v1/packages/${(await firstPackageId())}/coverage`, adminAuth, {
      entries: [{ locationId: north.id }],
    });

    const url = '/api/v1/packages?limit=50';
    await warm(url, adminAuth);

    const renamed = `North Again ${unique()}`;
    await patch(`/api/v1/locations/${north.id}`, adminAuth, { name: renamed });

    const after = await get(url, adminAuth);

    expect(after.cache).not.toBe('HIT');
    const areas = (after.body as { items: { coverageAreas: string[] }[] })
      .items
      .flatMap(item => item.coverageAreas);
    expect(areas.join(' ')).toContain(renamed);
  });

  it('re-counts packages on the services list when a package is added', async () => {
    const url = '/api/v1/services?limit=50';
    await warm(url, adminAuth);

    const countOf = (body: unknown) => (body as { id: string; providers: { packageCount: number }[] }[])
      .find(row => row.id === serviceId)!
      .providers
      .reduce((sum, p) => sum + p.packageCount, 0);

    const before = countOf((await get(url, adminAuth)).body);

    await post('/api/v1/packages', adminAuth, {
      serviceProviderId: providerId,
      name: `Extra ${unique()}`,
      price: '150.00',
    });

    const after = await get(url, adminAuth);

    expect(after.cache).not.toBe('HIT');
    expect(countOf(after.body)).toBe(before + 1);
  });

  it('re-renders the collector name on a receipt when that staff member is renamed', async () => {
    // The engineer collects, so the receipt carries their name.
    await post('/api/v1/payments/subscription', staffAuth, {
      customerId: north.customerId,
      amount: '0',
      reason: 'cache probe',
      reference: `REF-${unique()}`,
    });

    const url = '/api/v1/payments?limit=20';
    await warm(url, adminAuth);

    const renamed = `Renamed Engineer ${unique()}`;
    await patch(`/api/v1/staff/${staffMembershipId}`, adminAuth, { name: renamed });

    const after = await get(url, adminAuth);

    expect(after.cache).not.toBe('HIT');
    const names = (after.body as { items: { collectorName: string | null }[] })
      .items
      .map(item => item.collectorName);
    expect(names).toContain(renamed);
  });
});

async function firstPackageId(): Promise<string> {
  const { body } = await get('/api/v1/packages?limit=1', adminAuth);
  return (body as { items: { id: string }[] }).items[0]!.id;
}

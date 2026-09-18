import type { BuiltApp } from '@/app';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import {
  channels,
  customers,
  equipment,
  itemCatalog,
  locationCategories,
  locations,
  locationSchemas,
  membershipLocations,
  packages,
  rolePermissions,
  serviceCoverage,
  serviceProviders,
  services,
  subscriptions,
  tenantMemberships,
  users,
} from '@/db/schema';
import { hashPassword } from '@/security/password';
import { PERMISSIONS } from '@/security/permissions';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { as, bodyOf, signIn } from '@/test/http';

const { db, close } = createTestDb();
const unique = () => randomUUID().slice(0, 8);

let app: BuiltApp;
let cleanup: () => Promise<void>;
let tenantId: string;

let adminAuth: Record<string, string>;
let areaAuth: Record<string, string>;
let nowhereAuth: Record<string, string>;

const north = { id: '', blockId: '', customerId: '', customerName: '', serial: '' };
const south = { id: '', customerId: '', customerName: '', serial: '' };
let catalogId: string;

interface Catalogue { serviceId: string; providerId: string; packageId: string; channelId: string }
let northSold: Catalogue;
let southSold: Catalogue;
let everywhere: Catalogue;

const createdUserIds: string[] = [];

interface List<T> { items: T[]; total: number | null }

async function member(roleId: string, prefix: string): Promise<{ membershipId: string; headers: Record<string, string> }> {
  const email = uniqueEmail(prefix);
  const [user] = await db.insert(users).values({
    email,
    phone: uniquePhone(),
    name: prefix,
    passwordHash: await hashPassword(TEST_PASSWORD),
  }).returning();
  createdUserIds.push(user!.id);

  const [membership] = await db
    .insert(tenantMemberships)
    .values({ userId: user!.id, tenantId, roleId })
    .returning();

  return { membershipId: membership!.id, headers: as(await signIn(app, email), tenantId) };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const data = await seedAuthData(db);
  cleanup = data.cleanup;
  tenantId = data.tenantA.id;
  adminAuth = as(await signIn(app, data.active.email), tenantId);

  await db.insert(rolePermissions).values([
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.CUSTOMERS_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.LOCATIONS_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.INVENTORY_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.REPORTS_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.SERVICES_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.SERVICES_UPDATE, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.PACKAGES_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.INVENTORY_UPDATE, scope: 'LOCATION' as const },
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

  const node = async (name: string, parentId: string | null) => {
    const [row] = await db.insert(locations)
      .values({ tenantId, schemaId: schema!.id, categoryId: category!.id, name, parentId })
      .returning();
    return row!.id;
  };

  north.id = await node(`North ${unique()}`, null);
  north.blockId = await node(`North Block A ${unique()}`, north.id);
  south.id = await node(`South ${unique()}`, null);

  const [service] = await db.insert(services)
    .values({ tenantId, name: 'Cable TV', slug: `cable-${unique()}` })
    .returning();
  const [provider] = await db.insert(serviceProviders)
    .values({ tenantId, serviceId: service!.id, name: 'ACT', slug: `act-${unique()}` })
    .returning();
  const [pkg] = await db.insert(packages)
    .values({ tenantId, serviceProviderId: provider!.id, name: 'Gold', slug: `gold-${unique()}`, price: '349.00' })
    .returning();

  const catalogue = async (label: string, soldAt: string | null): Promise<Catalogue> => {
    const [svc] = await db.insert(services)
      .values({ tenantId, name: `${label} ${unique()}`, slug: `${label}-${unique()}` })
      .returning();
    const [prov] = await db.insert(serviceProviders)
      .values({ tenantId, serviceId: svc!.id, name: `${label} ISP`, slug: `${label}-isp-${unique()}` })
      .returning();
    const [plan] = await db.insert(packages)
      .values({ tenantId, serviceProviderId: prov!.id, name: `${label} Plan`, slug: `${label}-plan-${unique()}`, price: '199.00' })
      .returning();
    const [channel] = await db.insert(channels)
      .values({ tenantId, serviceProviderId: prov!.id, channelNumber: 101, name: `${label} News`, slug: `${label}-news-${unique()}` })
      .returning();

    if (soldAt !== null) {
      await db.insert(serviceCoverage)
        .values({ tenantId, serviceId: svc!.id, locationId: soldAt, isAvailable: true });
    }

    return { serviceId: svc!.id, providerId: prov!.id, packageId: plan!.id, channelId: channel!.id };
  };

  northSold = await catalogue('northsold', north.id);
  southSold = await catalogue('southsold', south.id);
  everywhere = await catalogue('everywhere', null);

  const [catalog] = await db.insert(itemCatalog)
    .values({ tenantId, name: `Set-top box ${unique()}`, code: `STB-${unique()}` })
    .returning();
  catalogId = catalog!.id;

  const half = async (area: { customerId: string; customerName: string; serial: string }, locationId: string, label: string) => {
    area.customerName = `${label} Subscriber ${unique()}`;
    const [customer] = await db.insert(customers).values({
      tenantId,
      name: area.customerName,
      phone: uniquePhone(),
      status: 'active',
      outstandingBalance: '100.00',
    }).returning();
    area.customerId = customer!.id;

    await db.insert(subscriptions).values({
      tenantId,
      customerId: customer!.id,
      serviceProviderId: provider!.id,
      packageId: pkg!.id,
      serviceAccountNumber: `ACC-${unique()}`,
      installationLocationId: locationId,
      status: 'active',
      price: '349.00',
    });

    area.serial = `SN-${label.toUpperCase()}-${unique()}`;
    await db.insert(equipment).values({
      tenantId,
      catalogId,
      locationId,
      serialNumber: area.serial,
      inventoryStatus: 'available',
    });
  };

  await half(north, north.blockId, 'north');
  await half(south, south.id, 'south');

  const areaLead = await member(SYSTEM_ROLES.STAFF, 'areaLead');
  await db.insert(membershipLocations).values({ membershipId: areaLead.membershipId, locationId: north.id });
  areaAuth = areaLead.headers;

  nowhereAuth = (await member(SYSTEM_ROLES.STAFF, 'nowhere')).headers;
});

afterAll(async () => {
  await app.close();
  await cleanup();
  await db.delete(users).where(inArray(users.id, createdUserIds));
  await close();
});

async function get(url: string, headers: Record<string, string>) {
  return app.inject({ method: 'GET', url, headers });
}

describe('an area grant narrows every list that hangs off the location tree', () => {
  it('gives the customers list the granted subtree and nothing beside it', async () => {
    const response = await get('/api/v1/customers?limit=100', areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    const ids = bodyOf<List<{ id: string }>>(response).items.map(row => row.id);
    expect(ids).toContain(north.customerId);
    expect(ids).not.toContain(south.customerId);
  });

  it('will not let ?locationId= widen the grant it is filtering inside', async () => {
    const response = await get(`/api/v1/customers?limit=100&locationId=${south.id}`, areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<List<{ id: string }>>(response).items).toEqual([]);
  });

  it('keeps search inside the grant too, not only the plain list', async () => {
    const response = await get(`/api/v1/customers?q=${encodeURIComponent(south.customerName)}`, areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<List<{ id: string }>>(response).items.map(row => row.id)).not.toContain(south.customerId);
  });

  it('answers 404 for a customer outside the area, even with the id in hand', async () => {
    const response = await get(`/api/v1/customers/${south.customerId}`, areaAuth);

    expect(response.statusCode).toBe(404);
    expect(bodyOf<{ code: string }>(response).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('gives the location tree the granted node and its children only', async () => {
    const response = await get('/api/v1/locations?limit=100', areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    const ids = bodyOf<List<{ id: string }>>(response).items.map(row => row.id);
    expect(ids).toEqual(expect.arrayContaining([north.id, north.blockId]));
    expect(ids).not.toContain(south.id);
  });

  it('refuses a node outside the grant', async () => {
    const response = await get(`/api/v1/locations/${south.id}`, areaAuth);

    expect(response.statusCode).toBe(403);
    expect(bodyOf<{ code: string }>(response).code).toBe('PERM_SCOPE_DENIED');
  });

  it('counts only the stock standing in the granted subtree', async () => {
    const response = await get('/api/v1/inventory/stock', areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<{ totalStock: number }[]>(response).reduce((sum, row) => sum + row.totalStock, 0)).toBe(1);
  });

  it('lists the serialized units of one catalogue item by grant, not by tenant', async () => {
    const response = await get(`/api/v1/inventory/stock/${catalogId}`, areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    const detail = bodyOf<{ totalStock: number; units: { serialNumber: string | null }[] }>(response);
    expect(detail.units.map(unit => unit.serialNumber)).toEqual([north.serial]);
    expect(detail.totalStock).toBe(1);
  });

  it('keeps an out-of-area serial out of the lookup', async () => {
    const response = await get(`/api/v1/inventory/lookup?q=${south.serial}`, areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<{ serialNumber: string | null }[]>(response)).toEqual([]);
  });

  it('offers only granted areas in the stock location filter', async () => {
    const response = await get('/api/v1/inventory/locations', areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<{ id: string }[]>(response).map(row => row.id)).not.toContain(south.id);
  });

  it('adds up the staff dashboard over the grant, not the tenant', async () => {
    const response = await get('/api/v1/analytics/dashboard/staff', areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<{ workload: { customers: number; activeConnections: number } }>(response).workload)
      .toMatchObject({ customers: 1, activeConnections: 1 });
  });
});

describe('the catalogue separates itself by coverage, without a second endpoint', () => {
  const idsOf = (response: { json: () => unknown }) => bodyOf<{ id: string }[]>(response).map(row => row.id);
  const pagedIdsOf = (response: { json: () => unknown }) => bodyOf<List<{ id: string }>>(response).items.map(row => row.id);

  it('lists the services sold in the granted area, plus the ones nobody bounded', async () => {
    const response = await get('/api/v1/services', areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    const ids = idsOf(response);
    expect(ids).toEqual(expect.arrayContaining([northSold.serviceId, everywhere.serviceId]));
    expect(ids).not.toContain(southSold.serviceId);
  });

  it('answers 404 for a service sold only in another area', async () => {
    const response = await get(`/api/v1/services/${southSold.serviceId}`, areaAuth);

    expect(response.statusCode).toBe(404);
  });

  it('splits providers the same way, on the same rule', async () => {
    const response = await get('/api/v1/service-providers', areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    const ids = idsOf(response);
    expect(ids).toEqual(expect.arrayContaining([northSold.providerId, everywhere.providerId]));
    expect(ids).not.toContain(southSold.providerId);
  });

  it('splits packages, which inherit the bound from the provider above them', async () => {
    const response = await get('/api/v1/packages?limit=100', areaAuth);

    expect(response.statusCode, response.body).toBe(200);
    const ids = pagedIdsOf(response);
    expect(ids).toEqual(expect.arrayContaining([northSold.packageId, everywhere.packageId]));
    expect(ids).not.toContain(southSold.packageId);
  });

  it('splits channels, which ride their provider', async () => {
    const mine = await get(`/api/v1/channels?serviceProviderId=${northSold.providerId}`, areaAuth);
    const theirs = await get(`/api/v1/channels?serviceProviderId=${southSold.providerId}`, areaAuth);

    expect(mine.statusCode, mine.body).toBe(200);
    expect(pagedIdsOf(mine)).toEqual([northSold.channelId]);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(pagedIdsOf(theirs)).toEqual([]);
  });

  it('shows only the coverage rows that govern the granted area', async () => {
    const mine = await get(`/api/v1/services/${northSold.serviceId}/coverage`, areaAuth);
    const theirs = await get(`/api/v1/services/${southSold.serviceId}/coverage`, areaAuth);

    expect(mine.statusCode, mine.body).toBe(200);
    expect(bodyOf<{ locationId: string }[]>(mine).map(row => row.locationId)).toEqual([north.id]);
    expect(theirs.statusCode).toBe(404);
  });

  it('answers availability inside the grant and refuses it outside', async () => {
    const inside = await get(`/api/v1/locations/${north.blockId}/available-services`, areaAuth);
    const outside = await get(`/api/v1/locations/${south.id}/available-services`, areaAuth);

    expect(inside.statusCode, inside.body).toBe(200);
    const offered = bodyOf<{ services: { id: string }[] }>(inside).services.map(row => row.id);
    expect(offered).toContain(northSold.serviceId);
    expect(offered).not.toContain(southSold.serviceId);

    expect(outside.statusCode).toBe(403);
    expect(bodyOf<{ code: string }>(outside).code).toBe('PERM_SCOPE_DENIED');
  });

  it('still shows an admin at ALL every entry, sold anywhere or nowhere', async () => {
    const response = await get('/api/v1/services', adminAuth);

    expect(idsOf(response)).toEqual(expect.arrayContaining([
      northSold.serviceId,
      southSold.serviceId,
      everywhere.serviceId,
    ]));
  });
});

describe('a write may not name an area the caller does not hold', () => {
  it('refuses coverage pointed outside the grant', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/service-providers/${northSold.providerId}/coverage`,
      headers: areaAuth,
      payload: { entries: [{ locationId: south.id }] },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(bodyOf<{ code: string }>(response).code).toBe('PERM_SCOPE_DENIED');
  });

  it('refuses stock booked into a depot outside the grant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/inward',
      headers: areaAuth,
      payload: { catalogId, locationId: south.id, quantity: 1 },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(bodyOf<{ code: string }>(response).code).toBe('PERM_SCOPE_DENIED');
  });
});

describe('a staff member holding no area reaches nothing, never everything', () => {
  it('returns an empty customer page rather than the tenant', async () => {
    const response = await get('/api/v1/customers?limit=100', nowhereAuth);

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<List<{ id: string }>>(response)).toMatchObject({ items: [], total: 0 });
  });

  it('returns an empty location page', async () => {
    const response = await get('/api/v1/locations?limit=100', nowhereAuth);

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<List<{ id: string }>>(response).items).toEqual([]);
  });

  it('sees no stock, in the list or in one item\'s units', async () => {
    const list = await get('/api/v1/inventory/stock', nowhereAuth);
    const item = await get(`/api/v1/inventory/stock/${catalogId}`, nowhereAuth);

    expect(list.statusCode, list.body).toBe(200);
    expect(bodyOf<{ totalStock: number }[]>(list).reduce((sum, row) => sum + row.totalStock, 0)).toBe(0);
    expect(item.statusCode, item.body).toBe(200);
    expect(bodyOf<{ units: unknown[] }>(item).units).toEqual([]);
  });

  it('is shown an empty catalogue rather than the tenant\'s', async () => {
    const services = await get('/api/v1/services', nowhereAuth);
    const plans = await get('/api/v1/packages?limit=100', nowhereAuth);

    expect(services.statusCode, services.body).toBe(200);
    expect(bodyOf<{ id: string }[]>(services)).toEqual([]);
    expect(bodyOf<List<{ id: string }>>(plans).items).toEqual([]);
  });

  it('reports a zeroed dashboard instead of the tenant total', async () => {
    const response = await get('/api/v1/analytics/dashboard/staff', nowhereAuth);

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<{ workload: Record<string, unknown> }>(response).workload)
      .toMatchObject({ customers: 0, dueCustomers: 0, outstanding: '0.00', activeConnections: 0 });
  });
});

describe('the same endpoints still answer tenant-wide for an admin at ALL', () => {
  it('sees both halves on every one of them', async () => {
    const [customerList, locationList, item] = await Promise.all([
      get('/api/v1/customers?limit=100', adminAuth),
      get('/api/v1/locations?limit=100', adminAuth),
      get(`/api/v1/inventory/stock/${catalogId}`, adminAuth),
    ]);

    expect(bodyOf<List<{ id: string }>>(customerList).items.map(row => row.id))
      .toEqual(expect.arrayContaining([north.customerId, south.customerId]));
    expect(bodyOf<List<{ id: string }>>(locationList).items.map(row => row.id))
      .toEqual(expect.arrayContaining([north.id, north.blockId, south.id]));
    expect(bodyOf<{ units: { serialNumber: string | null }[] }>(item).units.map(unit => unit.serialNumber).sort())
      .toEqual([north.serial, south.serial].sort());
  });
});

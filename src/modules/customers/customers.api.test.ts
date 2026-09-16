import type { CustomerDetail, CustomerPage } from './customer.schema';
import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import {
  customerEquipment,
  customers,
  equipment,
  locations,
  membershipLocations,
  subscriptions,
  tenantMemberships,
  users,
} from '@/db/schema';
import { hashPassword } from '@/security/password';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let adminAuth: Record<string, string>;
let fieldAuth: Record<string, string>;
let subscriberAuth: Record<string, string>;
const createdUserIds: string[] = [];
const createdCustomerIds: string[] = [];
const createdEquipmentIds: string[] = [];
let northCustomerId: string;
let southCustomerId: string;
let subscriberCustomerId: string;
let northAreaId: string;
let northAccountNumber: string;
let northSerialNumber: string;
let northVcNumber: string;
let northLocationCode: string;
let cableProviderId: string;
let cablePkgId: string;

const unique = () => randomUUID().slice(0, 8);

async function signIn(email: string): Promise<Record<string, string>> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: email, password: TEST_PASSWORD },
  });
  expect(login.statusCode).toBe(200);

  return { authorization: `Bearer ${bodyOf(login).accessToken}` };
}

async function makeUser(prefix: string, roleId: string): Promise<{ id: string; email: string; membershipId: string }> {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail(prefix), phone: uniquePhone(), name: prefix, passwordHash: await hashPassword(TEST_PASSWORD) })
    .returning();

  const [membership] = await db.insert(tenantMemberships).values({
    userId: row!.id,
    tenantId: data.tenantA.id,
    roleId,
  }).returning();

  createdUserIds.push(row!.id);

  return { id: row!.id, email: row!.email!, membershipId: membership!.id };
}

async function makeCustomer(input: {
  name: string;
  phone: string;
  locationId: string;
  providerId: string;
  packageId: string;
  userId?: string;
  accountNumber?: string;
  address?: string;
}): Promise<string> {
  const [customer] = await db.insert(customers).values({
    tenantId: data.tenantA.id,
    userId: input.userId ?? null,
    customerCode: `SSCN-${unique()}`,
    name: input.name,
    phone: input.phone,
    address: input.address,
    outstandingBalance: '120.50',
  }).returning();

  await db.insert(subscriptions).values({
    tenantId: data.tenantA.id,
    customerId: customer!.id,
    serviceProviderId: input.providerId,
    packageId: input.packageId,
    serviceAccountNumber: input.accountNumber ?? `ACC-${unique()}`,
    price: '349.00',
    billingCycle: 'monthly',
    installationLocationId: input.locationId,
  });

  createdCustomerIds.push(customer!.id);

  return customer!.id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  const admin = await makeUser('admin', SYSTEM_ROLES.ADMIN);
  adminAuth = await signIn(admin.email);
  const write = { ...adminAuth, 'content-type': 'application/json' };

  const service = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/services',
    headers: write,
    payload: { name: 'Cable TV', slug: `cable-${unique()}`, icon: 'tv' },
  }));

  const provider = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/service-providers',
    headers: write,
    payload: { serviceId: service.id, name: 'ACT Digital', slug: `act-${unique()}` },
  }));

  const pkg = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/packages',
    headers: write,
    payload: { serviceProviderId: provider.id, name: 'Gold', slug: `gold-${unique()}`, price: '349.00' },
  }));
  cableProviderId = provider.id;
  cablePkgId = pkg.id;

  const category = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/location-categories',
    headers: write,
    payload: { name: 'Area', slug: `area-${unique()}` },
  }));

  const locationSchema = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/location-schemas',
    headers: write,
    payload: { name: 'Flat', slug: `flat-${unique()}`, levels: [{ categoryId: category.id }] },
  }));

  const area = async (name: string) => app.inject({
    method: 'POST',
    url: '/api/v1/locations',
    headers: write,
    payload: { schemaId: locationSchema.id, name: `${name} ${unique()}` },
  });

  northAreaId = bodyOf<{ id: string }>(await area('North')).id;
  const southAreaId = bodyOf<{ id: string }>(await area('South')).id;

  const searchSuffix = unique().toUpperCase();
  northAccountNumber = `ACT-${searchSuffix}`;
  northSerialNumber = `STB-${searchSuffix}`;
  northVcNumber = `VC-${searchSuffix}`;
  northLocationCode = `LOC-${searchSuffix}`;
  await db.update(locations).set({ code: northLocationCode }).where(eq(locations.id, northAreaId));

  northCustomerId = await makeCustomer({
    name: 'Achanta Ramu',
    phone: '9490712587',
    locationId: northAreaId,
    providerId: provider.id,
    packageId: pkg.id,
    accountNumber: northAccountNumber,
  });

  const [northSubscription] = await db.select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.customerId, northCustomerId));
  const [box] = await db.insert(equipment).values({
    tenantId: data.tenantA.id,
    serialNumber: northSerialNumber,
    vcNumber: northVcNumber,
    macAddress: `AA:BB:${searchSuffix.slice(0, 2)}:11:22:33`,
    barcode: `BAR-${searchSuffix}`,
    inventoryStatus: 'allocated',
  }).returning();
  createdEquipmentIds.push(box!.id);
  await db.insert(customerEquipment).values({
    tenantId: data.tenantA.id,
    equipmentId: box!.id,
    customerId: northCustomerId,
    subscriptionId: northSubscription!.id,
  });
  southCustomerId = await makeCustomer({
    name: 'Bandaru Seetha',
    phone: '9876500011',
    locationId: southAreaId,
    providerId: provider.id,
    packageId: pkg.id,
  });

  const field = await makeUser('field', SYSTEM_ROLES.STAFF);
  await db.insert(membershipLocations).values({ membershipId: field.membershipId, locationId: northAreaId });
  fieldAuth = await signIn(field.email);

  const subscriber = await makeUser('subscriber', SYSTEM_ROLES.CUSTOMER);
  subscriberCustomerId = await makeCustomer({
    name: 'Chodavarapu Vani',
    phone: '9000011122',
    locationId: southAreaId,
    providerId: provider.id,
    packageId: pkg.id,
    userId: subscriber.id,
  });
  subscriberAuth = await signIn(subscriber.email);
});

afterAll(async () => {
  await db.delete(customers).where(inArray(customers.id, createdCustomerIds));
  if (createdEquipmentIds.length > 0)
    await db.delete(equipment).where(inArray(equipment.id, createdEquipmentIds));
  for (const id of createdUserIds)
    await db.delete(users).where(eq(users.id, id));
  await app.close();
  await data.cleanup();
  await close();
});

async function list(auth: Record<string, string>, query = ''): Promise<CustomerPage> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/customers${query}`, headers: auth });
  expect(response.statusCode).toBe(200);

  return bodyOf<CustomerPage>(response);
}

async function search(auth: Record<string, string>, query: string): Promise<CustomerPage> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/customers?q=${encodeURIComponent(query)}`,
    headers: auth,
  });
  expect(response.statusCode).toBe(200);
  return bodyOf<CustomerPage>(response);
}

describe('the customer list', () => {
  it('reads location codes from the existing path read model without another ancestry query', async () => {
    const result = await db.execute<{ codes: string[] }>(sql`
      SELECT codes FROM geo.location_paths WHERE id = ${northAreaId}
    `);

    expect(result.rows[0]?.codes).toContain(northLocationCode);
  });

  it('resolves the breadcrumb and the rollup on every row, so a client needs no follow-up call', async () => {
    const page = await list(adminAuth, '?limit=100');
    const row = page.items.find(item => item.id === northCustomerId)!;

    expect(row.locationPath).toContain('North');
    expect(row).toMatchObject({
      name: 'Achanta Ramu',
      phone: '9490712587',
      alternatePhone: null,
      whatsappNumber: null,
      address: null,
      subscriptions: 1,
      activeSubscriptions: 1,
      services: ['Cable TV'],
      outstandingBalance: '120.50',
    });
    expect(row.serviceAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountNumber: northAccountNumber }),
    ]));
    expect(row.locations[0]?.codes).toContain(northLocationCode);
    expect(row.equipment).toEqual(expect.arrayContaining([
      expect.objectContaining({ serialNumber: northSerialNumber, vcNumber: northVcNumber }),
    ]));
  });

  it('pages by cursor, and totals only on the first page', async () => {
    const first = await list(adminAuth, '?limit=1');

    expect(first.items).toHaveLength(1);
    expect(first.total).toBeGreaterThan(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await list(adminAuth, `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);

    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.total).toBeNull();
  });

  it('walks the whole list without repeating or skipping a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const page: CustomerPage = await list(adminAuth, `?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      seen.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null && seen.length < 50);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(northCustomerId);
    expect(seen).toContain(southCustomerId);
  });

  it('refuses a cursor that did not come from us', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/customers?cursor=not-a-cursor', headers: adminAuth });

    expect(response.statusCode).toBe(400);
  });

  it('searches name, phone and customer code with one parameter', async () => {
    expect((await list(adminAuth, '?q=Achanta')).items.map(i => i.id)).toContain(northCustomerId);
    expect((await list(adminAuth, '?q=9490712587')).items.map(i => i.id)).toContain(northCustomerId);
  });

  it('takes a location as a subtree, not a single node', async () => {
    const page = await list(adminAuth, `?locationId=${northAreaId}&limit=100`);
    const ids = page.items.map(item => item.id);

    expect(ids).toContain(northCustomerId);
    expect(ids).not.toContain(southCustomerId);
  });
});

describe('customer search', () => {
  it('ranks exact, prefix, substring and fuzzy names', async () => {
    expect((await search(adminAuth, 'Achanta Ramu')).items[0]?.id).toBe(northCustomerId);
    expect((await search(adminAuth, 'Achanta')).items[0]?.id).toBe(northCustomerId);
    expect((await search(adminAuth, 'chanta')).items[0]?.id).toBe(northCustomerId);
    expect((await search(adminAuth, 'Achnta Ramu')).items[0]?.id).toBe(northCustomerId);
  });

  it('searches phone, service account, location, serial and VC identifiers', async () => {
    const customerCode = (await search(adminAuth, 'Achanta Ramu')).items[0]!.customerCode!;
    expect((await search(adminAuth, '94907')).items.map(row => row.id)).toContain(northCustomerId);
    expect((await search(adminAuth, customerCode)).items.map(row => row.id)).toContain(northCustomerId);
    expect((await search(adminAuth, northAccountNumber.slice(4))).items.map(row => row.id)).toContain(northCustomerId);
    expect((await search(adminAuth, northSerialNumber)).items.map(row => row.id)).toContain(northCustomerId);
    expect((await search(adminAuth, northVcNumber)).items.map(row => row.id)).toContain(northCustomerId);
    expect((await search(adminAuth, 'North')).items.map(row => row.id)).toContain(northCustomerId);
    expect((await search(adminAuth, northLocationCode)).items.map(row => row.id)).toContain(northCustomerId);
  });

  it('returns every searchable account, location and equipment value', async () => {
    const result = (await search(adminAuth, northVcNumber)).items.find(row => row.id === northCustomerId)!;

    expect(result.serviceAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountNumber: northAccountNumber }),
    ]));
    expect(result.locations[0]?.path).toContain('North');
    expect(result.locations[0]?.codes).toContain(northLocationCode);
    expect(result.equipment).toEqual(expect.arrayContaining([
      expect.objectContaining({ serialNumber: northSerialNumber, vcNumber: northVcNumber }),
    ]));
    expect(result.matchedFields).toContain('equipment.vcNumber');
  });

  it('keeps a name match above an address-only match', async () => {
    const named = await makeCustomer({
      name: 'Ravi Kumar',
      phone: uniquePhone(),
      locationId: northAreaId,
      providerId: (await db.select({ id: subscriptions.serviceProviderId }).from(subscriptions).where(eq(subscriptions.customerId, northCustomerId)).limit(1))[0]!.id,
      packageId: (await db.select({ id: subscriptions.packageId }).from(subscriptions).where(eq(subscriptions.customerId, northCustomerId)).limit(1))[0]!.id,
    });
    await makeCustomer({
      name: `Street Resident ${unique()}`,
      phone: uniquePhone(),
      locationId: northAreaId,
      providerId: (await db.select({ id: subscriptions.serviceProviderId }).from(subscriptions).where(eq(subscriptions.customerId, northCustomerId)).limit(1))[0]!.id,
      packageId: (await db.select({ id: subscriptions.packageId }).from(subscriptions).where(eq(subscriptions.customerId, northCustomerId)).limit(1))[0]!.id,
      address: 'Ravi Kumar Street',
    });

    expect((await search(adminAuth, 'Ravi Kumar')).items[0]?.id).toBe(named);
  });

  it('never returns another tenant and still honors area scope', async () => {
    const [foreign] = await db.insert(customers).values({
      tenantId: data.tenantB.id,
      name: 'Tenant Secret Search Name',
      phone: '9111111111',
    }).returning();
    createdCustomerIds.push(foreign!.id);

    expect((await search(adminAuth, 'Tenant Secret Search Name')).items).toEqual([]);
    expect((await search(fieldAuth, 'Bandaru Seetha')).items).toEqual([]);
  });

  it('keeps the existing customer-list package filter during search', async () => {
    const page = await list(adminAuth, `?q=Achanta&packageId=${randomUUID()}`);

    expect(page.items).toEqual([]);
  });

  it('rejects blank searches and limits results', async () => {
    const blank = await app.inject({ method: 'GET', url: '/api/v1/customers?q=%20', headers: adminAuth });
    const tooMany = await app.inject({ method: 'GET', url: '/api/v1/customers?q=customer&limit=101', headers: adminAuth });
    const one = await app.inject({ method: 'GET', url: '/api/v1/customers?q=North&limit=1', headers: adminAuth });

    expect(blank.statusCode).toBe(400);
    expect(tooMany.statusCode).toBe(400);
    expect(bodyOf<CustomerPage>(one).items).toHaveLength(1);
  });
});

describe('what each scope may reach', () => {
  it('gives an admin the whole tenant', async () => {
    const ids = (await list(adminAuth, '?limit=100')).items.map(item => item.id);

    expect(ids).toContain(northCustomerId);
    expect(ids).toContain(southCustomerId);
  });

  it('gives area staff their area and nothing else', async () => {
    const ids = (await list(fieldAuth, '?limit=100')).items.map(item => item.id);

    expect(ids).toContain(northCustomerId);
    expect(ids).not.toContain(southCustomerId);
  });

  it('refuses a customer outside the area even when the id is known', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${southCustomerId}`,
      headers: fieldAuth,
    });

    expect(response.statusCode).toBe(404);
  });

  it('gives a subscriber only themselves', async () => {
    const ids = (await list(subscriberAuth)).items.map(item => item.id);

    expect(ids).toEqual([subscriberCustomerId]);
  });
});

describe('the customer detail', () => {
  it('returns the whole graph in one response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${northCustomerId}`,
      headers: adminAuth,
    });
    expect(response.statusCode).toBe(200);

    const detail = bodyOf<CustomerDetail>(response);

    expect(detail.locationPath).toContain('North');
    expect(detail.subscriptions).toHaveLength(1);

    expect(detail.subscriptions[0]).toMatchObject({
      status: 'active',
      price: '349.00',
      service: { name: 'Cable TV', icon: 'tv' },
      provider: { name: 'ACT Digital' },
      package: { name: 'Gold' },
    });

    expect(detail.summary).toMatchObject({
      subscriptions: 1,
      activeSubscriptions: 1,
      services: ['Cable TV'],
      monthlyValue: '349.00',
    });
  });

  it('is a 404 for an id that is not a customer of this tenant', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${randomUUID()}`,
      headers: adminAuth,
    });

    expect(response.statusCode).toBe(404);
  });

  it('filters customers by createdFrom and createdTo range', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const past = new Date(Date.now() - 86400000).toISOString();

    const emptyPage = await list(adminAuth, `?createdFrom=${encodeURIComponent(future)}`);
    expect(emptyPage.items).toHaveLength(0);

    const matchPage = await list(adminAuth, `?createdFrom=${encodeURIComponent(past)}`);
    expect(matchPage.items.length).toBeGreaterThan(0);
  });

  it('filters customers with 2 or more subscriptions or boxes of the same service using multiBox=true', async () => {
    const write = { ...adminAuth, 'content-type': 'application/json' };

    const bbService = bodyOf<{ id: string }>(await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: write,
      payload: { name: 'Broadband', slug: `bb-${unique()}`, icon: 'wifi' },
    }));
    const bbProvider = bodyOf<{ id: string }>(await app.inject({
      method: 'POST',
      url: '/api/v1/service-providers',
      headers: write,
      payload: { serviceId: bbService.id, name: 'ACT Fiber', slug: `fiber-${unique()}` },
    }));
    const bbPkg = bodyOf<{ id: string }>(await app.inject({
      method: 'POST',
      url: '/api/v1/packages',
      headers: write,
      payload: { serviceProviderId: bbProvider.id, name: 'Fiber 100', slug: `f100-${unique()}`, price: '699.00' },
    }));

    const multiSubCustId = await makeCustomer({
      name: `Alpha Sub ${unique()}`,
      phone: uniquePhone(),
      locationId: northAreaId,
      providerId: cableProviderId,
      packageId: cablePkgId,
    });
    await db.insert(subscriptions).values({
      tenantId: data.tenantA.id,
      customerId: multiSubCustId,
      serviceProviderId: cableProviderId,
      packageId: cablePkgId,
      serviceAccountNumber: `ACC-${unique()}`,
      price: '349.00',
      billingCycle: 'monthly',
      installationLocationId: northAreaId,
    });

    const multiBoxCustId = await makeCustomer({
      name: `Beta Box ${unique()}`,
      phone: uniquePhone(),
      locationId: northAreaId,
      providerId: cableProviderId,
      packageId: cablePkgId,
    });
    const [subB] = await db.select().from(subscriptions).where(eq(subscriptions.customerId, multiBoxCustId));
    const [box1] = await db.insert(equipment).values({
      tenantId: data.tenantA.id,
      serialNumber: `STB-B1-${unique()}`,
      inventoryStatus: 'allocated',
    }).returning();
    const [box2] = await db.insert(equipment).values({
      tenantId: data.tenantA.id,
      serialNumber: `STB-B2-${unique()}`,
      inventoryStatus: 'allocated',
    }).returning();
    createdEquipmentIds.push(box1!.id, box2!.id);
    await db.insert(customerEquipment).values([
      { tenantId: data.tenantA.id, equipmentId: box1!.id, customerId: multiBoxCustId, subscriptionId: subB!.id },
      { tenantId: data.tenantA.id, equipmentId: box2!.id, customerId: multiBoxCustId, subscriptionId: subB!.id },
    ]);

    const diffServiceCustId = await makeCustomer({
      name: `Diff Services ${unique()}`,
      phone: uniquePhone(),
      locationId: northAreaId,
      providerId: cableProviderId,
      packageId: cablePkgId,
    });
    await db.insert(subscriptions).values({
      tenantId: data.tenantA.id,
      customerId: diffServiceCustId,
      serviceProviderId: bbProvider.id,
      packageId: bbPkg.id,
      serviceAccountNumber: `ACC-BB-${unique()}`,
      price: '699.00',
      billingCycle: 'monthly',
      installationLocationId: northAreaId,
    });

    const multiBoxPage = await list(adminAuth, '?multiBox=true');
    const returnedIds = multiBoxPage.items.map(item => item.id);

    expect(returnedIds).toContain(multiSubCustId);
    expect(returnedIds).toContain(multiBoxCustId);
    expect(returnedIds).not.toContain(diffServiceCustId);
    expect(returnedIds).not.toContain(southCustomerId);

    const searchPage = await list(adminAuth, '?multiBox=true&q=Alpha');
    expect(searchPage.items.map(item => item.id)).toContain(multiSubCustId);
    expect(searchPage.items.map(item => item.id)).not.toContain(multiBoxCustId);
  });
});

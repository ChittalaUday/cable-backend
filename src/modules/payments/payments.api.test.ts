import type { CollectionPage, CollectionResponse } from './payment.schema';
import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import {
  accountTransactions,
  auditLogs,
  collections,
  customerEquipment,
  customers,
  equipment,
  itemCatalog,
  membershipLocations,
  rolePermissions,
  stockMovements,
  subscriptions,
  tenantMemberships,
  users,
} from '@/db/schema';
import { hashPassword } from '@/security/password';
import { PERMISSIONS } from '@/security/permissions';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let adminAuth: Record<string, string>;
let fieldAuth: Record<string, string>;
let fieldUserId: string;
let northCustomerId: string;
let southCustomerId: string;
let northSubscriptionId: string;
let ourCatalogId: string;
let theirCatalogId: string;

const createdUserIds: string[] = [];
const createdCustomerIds: string[] = [];
const unique = () => randomUUID().slice(0, 8);
const ref = () => `ref-${randomUUID()}`;

async function signIn(email: string): Promise<Record<string, string>> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: email, password: TEST_PASSWORD },
  });
  expect(login.statusCode).toBe(200);

  return { 'authorization': `Bearer ${bodyOf(login).accessToken}`, 'content-type': 'application/json' };
}

async function makeUser(prefix: string, roleId: string): Promise<{ id: string; email: string; membershipId: string }> {
  const [row] = await db.insert(users)
    .values({ email: uniqueEmail(prefix), phone: uniquePhone(), name: prefix, passwordHash: await hashPassword(TEST_PASSWORD) })
    .returning();

  const [membership] = await db.insert(tenantMemberships)
    .values({ userId: row!.id, tenantId: data.tenantA.id, roleId })
    .returning();

  createdUserIds.push(row!.id);

  return { id: row!.id, email: row!.email!, membershipId: membership!.id };
}

async function makeCustomer(locationId: string, providerId: string, packageId: string, due: string): Promise<{ customerId: string; subscriptionId: string }> {
  const [customer] = await db.insert(customers).values({
    tenantId: data.tenantA.id,
    customerCode: `SSCN-${unique()}`,
    name: `Subscriber ${unique()}`,
    phone: uniquePhone(),
    outstandingBalance: due,
  }).returning();

  const [subscription] = await db.insert(subscriptions).values({
    tenantId: data.tenantA.id,
    customerId: customer!.id,
    serviceProviderId: providerId,
    packageId,
    serviceAccountNumber: `ACC-${unique()}`,
    price: '349.00',
    outstandingBalance: due,
    installationLocationId: locationId,
  }).returning();

  createdCustomerIds.push(customer!.id);

  return { customerId: customer!.id, subscriptionId: subscription!.id };
}

async function collect(auth: Record<string, string>, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/payments/subscription', headers: auth, payload });
}

async function collectEquipment(auth: Record<string, string>, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/payments/equipment', headers: auth, payload });
}

async function balances(customerId: string): Promise<{ customer: string; line: string }> {
  const [customer] = await db.select({ balance: customers.outstandingBalance }).from(customers).where(eq(customers.id, customerId));
  const [line] = await db.select({ balance: subscriptions.outstandingBalance }).from(subscriptions).where(eq(subscriptions.customerId, customerId));

  return { customer: customer!.balance, line: line!.balance };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  await db.insert(rolePermissions).values([
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.PAYMENTS_VIEW, scope: 'LOCATION' },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.PAYMENTS_COLLECT, scope: 'LOCATION' },
    { roleId: SYSTEM_ROLES.CUSTOMER, permissionKey: PERMISSIONS.PAYMENTS_VIEW, scope: 'OWN' },
  ]).onConflictDoNothing();

  const admin = await makeUser('payadmin', SYSTEM_ROLES.ADMIN);
  adminAuth = await signIn(admin.email);

  const service = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/services',
    headers: adminAuth,
    payload: { name: 'Cable TV', slug: `cable-${unique()}`, icon: 'tv' },
  }));

  const provider = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/service-providers',
    headers: adminAuth,
    payload: { serviceId: service.id, name: 'ACT Digital', slug: `act-${unique()}` },
  }));

  const pkg = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/packages',
    headers: adminAuth,
    payload: { serviceProviderId: provider.id, name: 'Gold', slug: `gold-${unique()}`, price: '349.00' },
  }));

  const category = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/location-categories',
    headers: adminAuth,
    payload: { name: 'Area', slug: `area-${unique()}` },
  }));

  const locationSchema = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/location-schemas',
    headers: adminAuth,
    payload: { name: 'Flat', slug: `flat-${unique()}`, levels: [{ categoryId: category.id }] },
  }));

  const area = async (name: string) => bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/locations',
    headers: adminAuth,
    payload: { schemaId: locationSchema.id, name: `${name} ${unique()}` },
  })).id;

  const northAreaId = await area('North');
  const southAreaId = await area('South');

  const north = await makeCustomer(northAreaId, provider.id, pkg.id, '500.00');
  northCustomerId = north.customerId;
  northSubscriptionId = north.subscriptionId;
  southCustomerId = (await makeCustomer(southAreaId, provider.id, pkg.id, '500.00')).customerId;

  const field = await makeUser('collector', SYSTEM_ROLES.STAFF);
  fieldUserId = field.id;
  await db.insert(membershipLocations).values({ membershipId: field.membershipId, locationId: northAreaId });
  fieldAuth = await signIn(field.email);

  const [ours] = await db.insert(itemCatalog)
    .values({ tenantId: data.tenantA.id, name: 'Remote Control', defaultSalePrice: '150.00' })
    .returning();
  const [theirs] = await db.insert(itemCatalog)
    .values({ tenantId: data.tenantB.id, name: 'Their Remote', defaultSalePrice: '150.00' })
    .returning();
  ourCatalogId = ours!.id;
  theirCatalogId = theirs!.id;
});

afterAll(async () => {
  await db.execute(sql`ALTER TABLE billing.collections DISABLE TRIGGER collections_append_only`);
  await db.delete(collections).where(inArray(collections.customerId, createdCustomerIds));
  await db.execute(sql`ALTER TABLE billing.collections ENABLE TRIGGER collections_append_only`);
  await db.delete(accountTransactions).where(inArray(accountTransactions.customerId, createdCustomerIds));
  await db.delete(customerEquipment).where(inArray(customerEquipment.customerId, createdCustomerIds));
  await db.delete(stockMovements).where(inArray(stockMovements.tenantId, [data.tenantA.id, data.tenantB.id]));
  await db.delete(equipment).where(inArray(equipment.catalogId, [ourCatalogId, theirCatalogId]));
  await db.delete(customers).where(inArray(customers.id, createdCustomerIds));
  await db.delete(itemCatalog).where(inArray(itemCatalog.id, [ourCatalogId, theirCatalogId]));
  for (const id of createdUserIds)
    await db.delete(users).where(eq(users.id, id));
  await app.close();
  await data.cleanup();
  await close();
});

describe('recording a visit', () => {
  it('takes a full payment, moves the balance, and posts to the ledger', async () => {
    const response = await collect(fieldAuth, {
      customerId: northCustomerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
    });

    expect(response.statusCode).toBe(201);
    const receipt = bodyOf<CollectionResponse>(response);

    expect(receipt).toMatchObject({
      outcome: 'full',
      duesPaid: '500.00',
      totalCollected: '500.00',
      balanceAfter: '0.00',
      collectedBy: fieldUserId,
    });

    expect(await balances(northCustomerId)).toEqual({ customer: '0.00', line: '0.00' });

    const ledger = await db.select().from(accountTransactions).where(and(eq(accountTransactions.customerId, northCustomerId), eq(accountTransactions.transactionType, 'deposit')));

    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ credit: '500.00', closingBalance: '0.00', collectedBy: fieldUserId });
  });

  it('records a part payment for what is left', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');

    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '200.00',
      method: 'upi',
      reference: ref(),
    }));

    expect(receipt).toMatchObject({ outcome: 'partial', duesPaid: '200.00', balanceAfter: '300.00' });
    expect(await balances(customerId)).toEqual({ customer: '300.00', line: '300.00' });
  });

  it('records a visit that collected nothing, with its reason and no money moved', async () => {
    const before = await balances(southCustomerId);

    const receipt = bodyOf<CollectionResponse>(await collect(adminAuth, {
      customerId: southCustomerId,
      amount: '0',
      reason: 'Nobody home — will call back Friday',
      reference: ref(),
    }));

    expect(receipt).toMatchObject({ outcome: 'none', totalCollected: '0.00', method: null });
    expect(receipt.reason).toContain('Nobody home');
    expect(await balances(southCustomerId)).toEqual(before);

    const ledger = await db.select().from(accountTransactions).where(eq(accountTransactions.customerId, southCustomerId));
    expect(ledger).toHaveLength(0);
  });

  it('refuses a visit that collected nothing and says nothing about why', async () => {
    const response = await collect(adminAuth, { customerId: southCustomerId, amount: '0', reference: ref() });

    expect(response.statusCode).toBe(400);
  });

  it('records an equipment payment and issues new equipment to the customer', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');

    const response = await collectEquipment(fieldAuth, {
      customerId,
      amount: '150.00',
      method: 'cash',
      catalogId: ourCatalogId,
      serialNumber: `SN-${unique()}`,
      reference: ref(),
    });

    expect(response.statusCode).toBe(201);
    const receipt = bodyOf<CollectionResponse>(response);

    expect(receipt).toMatchObject({
      outcome: 'full',
      duesPaid: '150.00',
      totalCollected: '150.00',
      balanceAfter: '0.00',
    });
    expect(receipt.customerEquipmentId).not.toBeNull();
    expect(receipt.equipment).toMatchObject({
      itemName: 'Remote Control',
    });
  });

  it('records an equipment payment and updates or replaces existing equipment', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');

    const initial = bodyOf<CollectionResponse>(await collectEquipment(fieldAuth, {
      customerId,
      amount: '150.00',
      method: 'cash',
      catalogId: ourCatalogId,
      serialNumber: `SN-${unique()}`,
      reference: ref(),
    }));

    const replaced = bodyOf<CollectionResponse>(await collectEquipment(fieldAuth, {
      customerId,
      customerEquipmentId: initial.customerEquipmentId!,
      replacementSerialNumber: `SN-NEW-${unique()}`,
      returnCondition: 'damaged',
      amount: '50.00',
      method: 'upi',
      notes: 'Swapped damaged remote',
      reference: ref(),
    }));

    expect(replaced.outcome).toBe('full');
    expect(replaced.duesPaid).toBe('50.00');
    expect(replaced.customerEquipmentId).not.toBe(initial.customerEquipmentId);
    expect(replaced.equipment?.serialNumber).toContain('SN-NEW-');
  });

  it('refuses another operator\'s catalogue item', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');

    const response = await collectEquipment(fieldAuth, {
      customerId,
      amount: '0',
      reason: 'accessory only',
      catalogId: theirCatalogId,
      reference: ref(),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('no conflicts', () => {
  it('replays one reference as one receipt, not two payments', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const reference = ref();
    const payload = { customerId, amount: '200.00', method: 'cash', reference };

    const first = bodyOf<CollectionResponse>(await collect(fieldAuth, payload));
    const second = bodyOf<CollectionResponse>(await collect(fieldAuth, payload));

    expect(second.id).toBe(first.id);
    expect(await balances(customerId)).toEqual({ customer: '300.00', line: '300.00' });

    const rows = await db.select().from(collections).where(eq(collections.customerId, customerId));
    expect(rows).toHaveLength(1);
  });

  it('takes the money once when the same reference arrives twice at the same moment', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const payload = { customerId, amount: '200.00', method: 'cash', reference: ref() };

    const [a, b] = await Promise.all([collect(fieldAuth, payload), collect(fieldAuth, payload)]);

    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(bodyOf<CollectionResponse>(a).id).toBe(bodyOf<CollectionResponse>(b).id);
    expect(await balances(customerId)).toEqual({ customer: '300.00', line: '300.00' });

    const rows = await db.select().from(collections).where(eq(collections.customerId, customerId));
    expect(rows).toHaveLength(1);
  });

  it('keeps both payments when two collectors post at the same moment', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');

    const [a, b] = await Promise.all([
      collect(fieldAuth, { customerId, amount: '200.00', method: 'cash', reference: ref() }),
      collect(adminAuth, { customerId, amount: '300.00', method: 'upi', reference: ref() }),
    ]);

    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);

    expect(await balances(customerId)).toEqual({ customer: '0.00', line: '0.00' });
  });
});

describe('area scope', () => {
  it('refuses a customer outside the collector\'s areas, as a 404', async () => {
    const response = await collect(fieldAuth, {
      customerId: southCustomerId,
      amount: '100.00',
      method: 'cash',
      reference: ref(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('lists only the receipts in the collector\'s areas', async () => {
    await collect(adminAuth, {
      customerId: southCustomerId,
      amount: '100.00',
      method: 'cash',
      reference: ref(),
    });

    const page = bodyOf<CollectionPage>(await app.inject({ method: 'GET', url: '/api/v1/payments', headers: fieldAuth }));

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every(item => item.customerId !== southCustomerId)).toBe(true);
  });
});

describe('nobody else can change it', () => {
  it('refuses an UPDATE and a DELETE at the database, whatever the service does', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
    }));

    await expect(db.update(collections).set({ duesPaid: '1.00' }).where(eq(collections.id, receipt.id))).rejects.toThrow();
    await expect(db.delete(collections).where(eq(collections.id, receipt.id))).rejects.toThrow();

    const [stored] = await db.select().from(collections).where(eq(collections.id, receipt.id));
    expect(stored).toMatchObject({ duesPaid: '500.00' });
  });

  it('exposes no route that edits or deletes one', () => {
    const payments = app.routeTable.filter(route => route.url.startsWith('/api/v1/payments'));
    const methods = payments.flatMap(route => (Array.isArray(route.method) ? route.method : [route.method]));

    expect(methods).not.toContain('PATCH');
    expect(methods).not.toContain('PUT');
    expect(methods).not.toContain('DELETE');
  });

  it('corrects a receipt with a reversal and leaves the original standing', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
    }));

    const reversal = bodyOf<CollectionResponse>(await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${receipt.id}/reverse`,
      headers: adminAuth,
      payload: { reason: 'Keyed 500 instead of 50', reference: ref() },
    }));

    expect(reversal).toMatchObject({ outcome: 'refund', duesPaid: '-500.00', reversesId: receipt.id });
    expect(await balances(customerId)).toEqual({ customer: '500.00', line: '500.00' });

    const [original] = await db.select().from(collections).where(eq(collections.id, receipt.id));
    expect(original).toMatchObject({ duesPaid: '500.00', outcome: 'full' });
  });

  it('refuses a collector the power to reverse', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
    }));

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${receipt.id}/reverse`,
      headers: fieldAuth,
      payload: { reason: 'Undoing my own shortfall', reference: ref() },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('everything is audited', () => {
  it('writes an audit row naming the actor and the receipt', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
    }));

    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, receipt.id));

    expect(row).toMatchObject({
      action: 'payment_collection.created',
      entityType: 'payment_collection',
      actorId: fieldUserId,
      tenantId: data.tenantA.id,
    });
  });
});

describe('where it was collected', () => {
  const DOOR = { latitude: 16.8697, longitude: 81.9342 };

  it('keeps the fix and the accuracy that came with it', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');

    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
      ...DOOR,
      gpsAccuracyM: 8.5,
    }));

    expect(receipt).toMatchObject({
      latitude: '16.8697000',
      longitude: '81.9342000',
      gpsAccuracyM: '8.50',
    });
  });

  it('records a receipt from a phone with no fix at all', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');

    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
    }));

    expect(receipt).toMatchObject({ latitude: null, longitude: null, gpsAccuracyM: null });
  });

  it('refuses half a position', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');

    const response = await collect(fieldAuth, {
      customerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
      latitude: DOOR.latitude,
    });

    expect(bodyOf<CollectionResponse>(response).latitude).toBeNull();
  });

  it('finds the receipts written near a place, and not the ones far from it', async () => {
    const near = await makeCustomerLikeNorth('500.00');
    const far = await makeCustomerLikeNorth('500.00');

    await collect(fieldAuth, {
      customerId: near.customerId,
      amount: '100.00',
      method: 'cash',
      reference: ref(),
      ...DOOR,
      gpsAccuracyM: 6,
    });

    await collect(fieldAuth, {
      customerId: far.customerId,
      amount: '100.00',
      method: 'cash',
      reference: ref(),
      latitude: DOOR.latitude,
      longitude: DOOR.longitude + 0.03,
      gpsAccuracyM: 6,
    });

    const page = bodyOf<CollectionPage>(await app.inject({
      method: 'GET',
      url: `/api/v1/payments?nearLatitude=${DOOR.latitude}&nearLongitude=${DOOR.longitude}&withinM=250`,
      headers: fieldAuth,
    }));

    const customers = page.items.map(item => item.customerId);
    expect(customers).toContain(near.customerId);
    expect(customers).not.toContain(far.customerId);
  });

  it('leaves a receipt with no fix out of a spatial search rather than guessing', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');

    await collect(fieldAuth, { customerId, amount: '100.00', method: 'cash', reference: ref() });

    const page = bodyOf<CollectionPage>(await app.inject({
      method: 'GET',
      url: `/api/v1/payments?nearLatitude=${DOOR.latitude}&nearLongitude=${DOOR.longitude}&withinM=250`,
      headers: fieldAuth,
    }));

    expect(page.items.map(item => item.customerId)).not.toContain(customerId);
  });
});

describe('edge cases', () => {
  it('will not guess which line a payment is for', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const template = await northTemplate();

    await db.insert(subscriptions).values({
      tenantId: data.tenantA.id,
      customerId,
      serviceProviderId: template.providerId,
      packageId: template.packageId,
      serviceAccountNumber: `ACC-${unique()}`,
      price: '199.00',
      outstandingBalance: '199.00',
      installationLocationId: template.locationId,
    });

    const guess = await collect(fieldAuth, { customerId, amount: '100.00', method: 'cash', reference: ref() });
    expect(guess.statusCode).toBe(400);

    const [named] = await db.select({ id: subscriptions.id, balance: subscriptions.outstandingBalance })
      .from(subscriptions)
      .where(and(eq(subscriptions.customerId, customerId), eq(subscriptions.outstandingBalance, '199.00')));

    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      subscriptionId: named!.id,
      amount: '199.00',
      method: 'cash',
      reference: ref(),
    }));

    expect(receipt).toMatchObject({ outcome: 'full', balanceAfter: '0.00' });
    const lines = await db.select({ balance: subscriptions.outstandingBalance })
      .from(subscriptions)
      .where(eq(subscriptions.customerId, customerId));
    expect(lines.map(line => line.balance).sort()).toEqual(['0.00', '500.00']);
  });

  it('refuses a subscription belonging to somebody else', async () => {
    const mine = await makeCustomerLikeNorth('500.00');
    const theirs = await makeCustomerLikeNorth('500.00');

    const response = await collect(fieldAuth, {
      customerId: mine.customerId,
      subscriptionId: theirs.subscriptionId,
      amount: '100.00',
      method: 'cash',
      reference: ref(),
    });

    expect(response.statusCode).toBe(404);
  });

  it('takes an advance and carries the account into credit', async () => {
    const { customerId } = await makeCustomerLikeNorth('100.00');

    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '250.00',
      method: 'upi',
      reference: ref(),
    }));

    expect(receipt).toMatchObject({ outcome: 'full', balanceAfter: '-150.00' });
    expect(await balances(customerId)).toEqual({ customer: '-150.00', line: '-150.00' });
  });

  it('keeps the paise exact over repeated part payments', async () => {
    const { customerId } = await makeCustomerLikeNorth('100.05');

    for (const amount of ['33.35', '33.35', '33.35'])
      expect((await collect(fieldAuth, { customerId, amount, method: 'cash', reference: ref() })).statusCode).toBe(201);

    expect(await balances(customerId)).toEqual({ customer: '0.00', line: '0.00' });
  });

  it('honours the time a queued receipt was actually collected', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
      collectedAt: yesterday.toISOString(),
    }));

    expect(new Date(receipt.collectedAt).getTime()).toBe(yesterday.getTime());
  });

  it('refuses a reference another collector already used', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const reference = ref();

    expect((await collect(fieldAuth, { customerId, amount: '100.00', method: 'cash', reference })).statusCode).toBe(201);

    const response = await collect(adminAuth, { customerId, amount: '100.00', method: 'cash', reference });
    expect(response.statusCode).toBe(409);
  });

  it('reverses a receipt once and only once', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
    }));

    const reverse = async () => app.inject({
      method: 'POST',
      url: `/api/v1/payments/${receipt.id}/reverse`,
      headers: adminAuth,
      payload: { reason: 'Keyed twice', reference: ref() },
    });

    const first = await reverse();
    expect(first.statusCode).toBe(201);

    expect((await reverse()).statusCode).toBe(409);

    const reversalId = bodyOf<CollectionResponse>(first).id;
    const onAReversal = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${reversalId}/reverse`,
      headers: adminAuth,
      payload: { reason: 'Undo the undo', reference: ref() },
    });
    expect(onAReversal.statusCode).toBe(409);
  });

  it('replays a retried reversal instead of unwinding twice', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const receipt = bodyOf<CollectionResponse>(await collect(fieldAuth, {
      customerId,
      amount: '500.00',
      method: 'cash',
      reference: ref(),
    }));

    const reference = ref();
    const reverse = async () => app.inject({
      method: 'POST',
      url: `/api/v1/payments/${receipt.id}/reverse`,
      headers: adminAuth,
      payload: { reason: 'Keyed 500 instead of 50', reference },
    });

    const first = await reverse();
    const again = await reverse();

    expect([first.statusCode, again.statusCode]).toEqual([201, 201]);
    expect(bodyOf<CollectionResponse>(again).id).toBe(bodyOf<CollectionResponse>(first).id);
    expect(await balances(customerId)).toEqual({ customer: '500.00', line: '500.00' });
  });

  it('takes the equipment charge back off the account when the receipt is reversed', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const receipt = bodyOf<CollectionResponse>(await collectEquipment(fieldAuth, {
      customerId,
      amount: '150.00',
      method: 'cash',
      catalogId: ourCatalogId,
      reference: ref(),
    }));

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${receipt.id}/reverse`,
      headers: adminAuth,
      payload: { reason: 'Customer returned the remote', reference: ref() },
    });

    expect(response.statusCode).toBe(201);
    const reversal = bodyOf<CollectionResponse>(response);
    expect(reversal).toMatchObject({
      outcome: 'refund',
      duesPaid: '-150.00',
      customerEquipmentId: receipt.customerEquipmentId,
    });
  });

  it('shows a subscriber their own receipts and nobody else\'s', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    const subscriber = await makeUser('payee', SYSTEM_ROLES.CUSTOMER);
    await db.update(customers).set({ userId: subscriber.id }).where(eq(customers.id, customerId));

    await collect(fieldAuth, { customerId, amount: '500.00', method: 'cash', reference: ref() });
    await collect(fieldAuth, { customerId: northCustomerId, amount: '0', reason: 'out', reference: ref() });

    const auth = await signIn(subscriber.email);
    const page = bodyOf<CollectionPage>(await app.inject({ method: 'GET', url: '/api/v1/payments', headers: auth }));

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.customerId).toBe(customerId);
  });

  it('gives a collector with no areas an empty page, never the tenant', async () => {
    const stranded = await makeUser('noareas', SYSTEM_ROLES.STAFF);
    const auth = await signIn(stranded.email);

    const page = bodyOf<CollectionPage>(await app.inject({ method: 'GET', url: '/api/v1/payments', headers: auth }));

    expect(page.items).toEqual([]);
    expect(page.totals.totalCollected).toBe('0.00');
  });

  it('adds up the filter, not the page, and pages by cursor', async () => {
    const { customerId } = await makeCustomerLikeNorth('900.00');

    for (const amount of ['100.00', '200.00', '300.00'])
      await collect(fieldAuth, { customerId, amount, method: 'cash', reference: ref() });

    const first = bodyOf<CollectionPage>(await app.inject({
      method: 'GET',
      url: `/api/v1/payments?customerId=${customerId}&limit=2`,
      headers: fieldAuth,
    }));

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.totals).toMatchObject({ totalCollected: '600.00', receipts: 3 });

    const second = bodyOf<CollectionPage>(await app.inject({
      method: 'GET',
      url: `/api/v1/payments?customerId=${customerId}&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
      headers: fieldAuth,
    }));

    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(3);
  });

  it('narrows to one collector\'s own round', async () => {
    const { customerId } = await makeCustomerLikeNorth('500.00');
    await collect(fieldAuth, { customerId, amount: '100.00', method: 'cash', reference: ref() });
    await collect(adminAuth, { customerId, amount: '100.00', method: 'cash', reference: ref() });

    const mine = bodyOf<CollectionPage>(await app.inject({
      method: 'GET',
      url: `/api/v1/payments?customerId=${customerId}&collectedBy=me`,
      headers: fieldAuth,
    }));

    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]!.collectedBy).toBe(fieldUserId);
  });

  it('refuses a malformed cursor rather than ignoring it', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/payments?cursor=not-a-cursor', headers: fieldAuth });

    expect(response.statusCode).toBe(400);
  });

  it('answers a receipt outside the caller\'s areas with a 404, not a 403', async () => {
    const receipt = bodyOf<CollectionResponse>(await collect(adminAuth, {
      customerId: southCustomerId,
      amount: '100.00',
      method: 'cash',
      reference: ref(),
    }));

    const response = await app.inject({ method: 'GET', url: `/api/v1/payments/${receipt.id}`, headers: fieldAuth });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a payment against another operator\'s customer', async () => {
    const [theirs] = await db.insert(customers)
      .values({ tenantId: data.tenantB.id, customerCode: `OTHER-${unique()}`, name: 'Other operator', phone: uniquePhone() })
      .returning();
    createdCustomerIds.push(theirs!.id);

    const response = await collect(adminAuth, {
      customerId: theirs!.id,
      amount: '100.00',
      method: 'cash',
      reference: ref(),
    });

    expect(response.statusCode).toBe(404);
  });
});

async function northTemplate(): Promise<{ locationId: string; providerId: string; packageId: string }> {
  const [template] = await db.select({
    locationId: subscriptions.installationLocationId,
    providerId: subscriptions.serviceProviderId,
    packageId: subscriptions.packageId,
  }).from(subscriptions).where(eq(subscriptions.id, northSubscriptionId));

  return template!;
}

async function makeCustomerLikeNorth(due: string): Promise<{ customerId: string; subscriptionId: string }> {
  const template = await northTemplate();

  return makeCustomer(template.locationId, template.providerId, template.packageId, due);
}

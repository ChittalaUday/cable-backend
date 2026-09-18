import type { CustomerProfile } from '../customer.schema';
import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { customers, subscriptions, tenantMemberships, users } from '@/db/schema';
import { hashPassword } from '@/security/password';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let customerAuth: Record<string, string>;
let staffAuth: Record<string, string>;
let customerUserId: string;
let staffUserId: string;
let customerId: string;

interface MeBody { customer: CustomerProfile | null }

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

async function makeUser(prefix: string): Promise<{ id: string; email: string }> {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail(prefix), phone: uniquePhone(), name: prefix, passwordHash: await hashPassword(TEST_PASSWORD) })
    .returning();

  await db.insert(tenantMemberships).values({
    userId: row!.id,
    tenantId: data.tenantA.id,
    roleId: prefix === 'staff' ? SYSTEM_ROLES.ADMIN : SYSTEM_ROLES.CUSTOMER,
  });

  return { id: row!.id, email: row!.email! };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  const subscriber = await makeUser('subscriber');
  const staff = await makeUser('staff');
  customerUserId = subscriber.id;
  staffUserId = staff.id;

  staffAuth = await signIn(staff.email);
  const adminAuth = { ...staffAuth, 'x-tenant-id': data.tenantA.id, 'content-type': 'application/json' };

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
    payload: { serviceProviderId: provider.id, name: 'Gold', slug: `gold-${unique()}`, price: '349.00', billingCycle: 'monthly' },
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

  const area = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/locations',
    headers: adminAuth,
    payload: { schemaId: locationSchema.id, name: `Mandapeta ${unique()}` },
  }));

  const [customer] = await db.insert(customers).values({
    tenantId: data.tenantA.id,
    userId: customerUserId,
    customerCode: `SSCN-${unique()}`,
    outstandingBalance: '120.50',
    whatsappNumber: '9876543210',
    address: '4-21, Main Road, Mandapeta 533308',
  }).returning();
  customerId = customer!.id;

  await db.insert(subscriptions).values({
    tenantId: data.tenantA.id,
    customerId,
    serviceProviderId: provider.id,
    packageId: pkg.id,
    serviceAccountNumber: `ACC-${unique()}`,
    price: '349.00',
    billingCycle: 'monthly',
    installationLocationId: area.id,
  });

  customerAuth = await signIn(subscriber.email);
});

afterAll(async () => {
  await db.delete(customers).where(eq(customers.id, customerId));
  await db.delete(users).where(eq(users.id, customerUserId));
  await db.delete(users).where(eq(users.id, staffUserId));
  await app.close();
  await data.cleanup();
  await close();
});

describe('/auth/me for a subscriber', () => {
  it('merges the customer record, its address and what it is subscribed to', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: customerAuth });
    expect(response.statusCode).toBe(200);

    const customer = bodyOf<MeBody>(response).customer!;

    expect(customer).toMatchObject({ id: customerId, outstandingBalance: '120.50', whatsappNumber: '9876543210' });
    expect(customer.address).toBe('4-21, Main Road, Mandapeta 533308');
    expect(customer.locationId).not.toBeNull();

    expect(customer.subscriptions).toHaveLength(1);
    expect(customer.subscriptions[0]).toMatchObject({
      status: 'active',
      billingCycle: 'monthly',
      price: '349.00',
      service: { name: 'Cable TV', icon: 'tv' },
      provider: { name: 'ACT Digital' },
      package: { name: 'Gold' },
    });

    expect(typeof customer.subscriptions[0]!.price).toBe('string');
  });

  it('carries the one-glance summary a home screen renders', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: customerAuth });

    expect(bodyOf<MeBody>(response).customer!.summary).toEqual({
      subscriptions: 1,
      activeSubscriptions: 1,
      services: ['Cable TV'],
      outstandingBalance: '120.50',
    });
  });

  it('is null for staff, who have a login but no subscriber record', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: staffAuth });

    expect(response.statusCode).toBe(200);
    expect(bodyOf<MeBody>(response).customer).toBeNull();
  });

  it('is null when the caller has not said which tenant they are acting in', async () => {
    const twoTenants = await signIn(data.active.email);
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: twoTenants });

    expect(response.statusCode).toBe(200);
    expect(bodyOf<MeBody>(response).customer).toBeNull();
  });
});

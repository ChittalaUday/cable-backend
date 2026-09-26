import type { Ticket } from '../ticket.schema';
import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { customers, membershipLocations, rolePermissions, subscriptions, tenantMemberships, tickets, users } from '@/db/schema';
import { hashPassword } from '@/security/password';
import { PERMISSIONS } from '@/security/permissions';
import { createTestDb } from '@/test/db';
import { seedAuthData, snapshotRoleGrants, TEST_PASSWORD, uniqueDeviceId, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let adminAuth: Record<string, string>;
let northAuth: Record<string, string>;
let subscriberAuth: Record<string, string>;
let tenantId: string;
let northCustomerId: string;
let northSubscriptionId: string;
let southCustomerId: string;
let subscriberCustomerId: string;
let northEngineerId: string;
let restoreGrants: () => Promise<void>;

const createdUserIds: string[] = [];
const createdCustomerIds: string[] = [];

async function signIn(email: string): Promise<Record<string, string>> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: email, password: TEST_PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);

  return { 'authorization': `Bearer ${bodyOf(login).accessToken}`, 'x-tenant-id': tenantId };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);
  tenantId = data.tenantA.id;

  adminAuth = await signIn(data.active.email);
  const write = { ...adminAuth, 'content-type': 'application/json' };

  const post = async <T>(url: string, payload: Record<string, unknown>): Promise<T> => {
    const response = await app.inject({ method: 'POST', url, headers: write, payload });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(201);
    return bodyOf<T>(response);
  };

  const service = await post<{ id: string }>('/api/v1/services', { name: 'Cable', slug: `cable-${randomUUID()}` });
  const provider = await post<{ id: string }>('/api/v1/service-providers', { serviceId: service.id, name: 'Provider', slug: `prov-${randomUUID()}` });
  const pkg = await post<{ id: string }>('/api/v1/packages', { serviceProviderId: provider.id, name: 'Base', slug: `base-${randomUUID()}`, price: '350.00' });
  const category = await post<{ id: string }>('/api/v1/location-categories', { name: 'Area', slug: `area-${randomUUID()}` });
  const schema = await post<{ id: string }>('/api/v1/location-schemas', { name: 'Flat', slug: `flat-${randomUUID()}`, levels: [{ categoryId: category.id }] });
  const north = await post<{ id: string }>('/api/v1/locations', { schemaId: schema.id, name: 'North' });
  const south = await post<{ id: string }>('/api/v1/locations', { schemaId: schema.id, name: 'South' });

  const makeCustomer = async (name: string, locationId: string) => {
    const [customer] = await db.insert(customers).values({
      tenantId,
      name,
      phone: uniquePhone(),
      status: 'active',
    }).returning();
    createdCustomerIds.push(customer!.id);
    const [line] = await db.insert(subscriptions).values({
      tenantId,
      customerId: customer!.id,
      serviceProviderId: provider.id,
      packageId: pkg.id,
      serviceAccountNumber: `ACC-${randomUUID().slice(0, 8)}`,
      installationLocationId: locationId,
      status: 'active',
      price: '350.00',
    }).returning();

    return { customerId: customer!.id, subscriptionId: line!.id };
  };

  ({ customerId: northCustomerId, subscriptionId: northSubscriptionId } = await makeCustomer('Achanta Ramu', north.id));
  ({ customerId: southCustomerId } = await makeCustomer('Bandaru Seetha', south.id));
  ({ customerId: subscriberCustomerId } = await makeCustomer('Chalapathi Rao', north.id));

  const [engineer] = await db.insert(users).values({
    email: uniqueEmail('engineer'),
    phone: uniquePhone(),
    name: 'North Engineer',
    passwordHash: await hashPassword(TEST_PASSWORD),
  }).returning();
  northEngineerId = engineer!.id;
  createdUserIds.push(engineer!.id);

  const [membership] = await db.insert(tenantMemberships).values({
    userId: engineer!.id,
    tenantId,
    roleId: SYSTEM_ROLES.STAFF,
  }).returning();
  await db.insert(membershipLocations).values({ membershipId: membership!.id, locationId: north.id });

  // The shipped matrix gives staff `tickets.*` at ASSIGNED; the cut-down
  // fixture grants do not, and the scope cases are the point of this file.
  // Put back in afterAll — the three role rows are shared by every test file.
  restoreGrants = await snapshotRoleGrants(db, [SYSTEM_ROLES.STAFF, SYSTEM_ROLES.CUSTOMER]);
  await db.insert(rolePermissions).values([
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.TICKETS_VIEW, scope: 'ASSIGNED' },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.TICKETS_CREATE, scope: 'LOCATION' },
    { roleId: SYSTEM_ROLES.CUSTOMER, permissionKey: PERMISSIONS.TICKETS_VIEW, scope: 'OWN' },
    { roleId: SYSTEM_ROLES.CUSTOMER, permissionKey: PERMISSIONS.TICKETS_CREATE, scope: 'OWN' },
  ]).onConflictDoNothing();
  app.access.invalidate();

  northAuth = await signIn(engineer!.email!);

  // A subscriber signed in to the app, linked to their own customer record.
  const [subscriber] = await db.insert(users).values({
    email: uniqueEmail('subscriber'),
    phone: uniquePhone(),
    name: 'Chalapathi Rao',
    passwordHash: await hashPassword(TEST_PASSWORD),
  }).returning();
  createdUserIds.push(subscriber!.id);
  await db.insert(tenantMemberships).values({ userId: subscriber!.id, tenantId, roleId: SYSTEM_ROLES.CUSTOMER });
  await db.update(customers).set({ userId: subscriber!.id }).where(eq(customers.id, subscriberCustomerId));

  subscriberAuth = await signIn(subscriber!.email!);
});

afterAll(async () => {
  await restoreGrants();
  await db.delete(tickets).where(eq(tickets.tenantId, tenantId));
  await db.delete(customers).where(inArray(customers.id, createdCustomerIds));
  for (const id of createdUserIds)
    await db.delete(users).where(eq(users.id, id));
  await app.close();
  await data.cleanup();
  await close();
});

async function raise(auth: Record<string, string>, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/tickets',
    headers: { ...auth, 'content-type': 'application/json' },
    payload,
  });
}

async function patch(auth: Record<string, string>, id: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/tickets/${id}`,
    headers: { ...auth, 'content-type': 'application/json' },
    payload,
  });
}

async function listFor(auth: Record<string, string>, query = ''): Promise<Ticket[]> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/tickets${query}`, headers: auth });
  expect(response.statusCode, response.body).toBe(200);

  return bodyOf<{ items: Ticket[] }>(response).items;
}

describe('raising a complaint', () => {
  it('numbers it off the tenant and files it against the line', async () => {
    const response = await raise(adminAuth, {
      customerId: northCustomerId,
      subscriptionId: northSubscriptionId,
      category: 'no_signal',
      priority: 'high',
      subject: 'No signal since last night',
      description: 'Whole block is dark',
    });

    expect(response.statusCode, response.body).toBe(201);
    const ticket = bodyOf<Ticket>(response);

    expect(ticket.ticketNo).toMatch(/-T-\d{6}$/);
    expect(ticket).toMatchObject({ status: 'open', priority: 'high', category: 'no_signal' });
    expect(ticket.customer.name).toBe('Achanta Ramu');
    expect(ticket.subscription?.id).toBe(northSubscriptionId);
    // The area comes off the line, which is what every scoped list filters on.
    expect(ticket.locationId).not.toBeNull();
  });

  it('hands out a different number every time', async () => {
    const [first, second] = await Promise.all([
      raise(adminAuth, { customerId: northCustomerId, subject: 'First fault' }),
      raise(adminAuth, { customerId: northCustomerId, subject: 'Second fault' }),
    ]);

    expect(bodyOf<Ticket>(first).ticketNo).not.toBe(bodyOf<Ticket>(second).ticketNo);
  });

  it('takes the area from the customer when no line is named', async () => {
    const response = await raise(adminAuth, { customerId: northCustomerId, subject: 'Bill query', category: 'billing' });

    expect(response.statusCode).toBe(201);
    expect(bodyOf<Ticket>(response).locationId).not.toBeNull();
  });

  it('refuses a customer that is not this tenant\'s', async () => {
    const response = await raise(adminAuth, { customerId: randomUUID(), subject: 'Ghost complaint' });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a line that is not that customer\'s', async () => {
    const response = await raise(adminAuth, {
      customerId: southCustomerId,
      subscriptionId: northSubscriptionId,
      subject: 'Wrong line',
    });

    expect(response.statusCode).toBe(404);
  });

  it('lets a subscriber complain about their own account', async () => {
    const response = await raise(subscriberAuth, { customerId: subscriberCustomerId, subject: 'No signal at home' });

    expect(response.statusCode, response.body).toBe(201);
  });

  it('refuses a subscriber complaining about somebody else\'s line', async () => {
    const response = await raise(subscriberAuth, { customerId: northCustomerId, subject: 'Neighbour complaint' });

    expect(response.statusCode, response.body).toBe(404);
  });

  it('refuses a subject too short to mean anything', async () => {
    const response = await raise(adminAuth, { customerId: northCustomerId, subject: 'x' });

    expect(response.statusCode).toBe(400);
  });
});

describe('who sees which complaint', () => {
  it('shows an area engineer the unclaimed faults in their own areas and nothing else', async () => {
    const north = await raise(adminAuth, { customerId: northCustomerId, subject: 'North outage' });
    const south = await raise(adminAuth, { customerId: southCustomerId, subject: 'South outage' });
    expect(south.statusCode).toBe(201);

    const visible = await listFor(northAuth);
    const ids = visible.map(row => row.id);

    expect(ids).toContain(bodyOf<Ticket>(north).id);
    expect(ids).not.toContain(bodyOf<Ticket>(south).id);
  });

  it('answers 404, not 403, for a complaint outside the engineer\'s areas', async () => {
    const south = bodyOf<Ticket>(await raise(adminAuth, { customerId: southCustomerId, subject: 'Out of reach' }));

    const response = await app.inject({ method: 'GET', url: `/api/v1/tickets/${south.id}`, headers: northAuth });

    expect(response.statusCode).toBe(404);
  });

  it('narrows to what is still being worked on', async () => {
    const open = bodyOf<Ticket>(await raise(adminAuth, { customerId: northCustomerId, subject: 'Still open' }));
    const done = bodyOf<Ticket>(await raise(adminAuth, { customerId: northCustomerId, subject: 'Already done' }));
    expect((await patch(adminAuth, done.id, { status: 'resolved', resolution: 'Reseated the cable' })).statusCode).toBe(200);

    const ids = (await listFor(adminAuth, '?openOnly=true&limit=100')).map(row => row.id);

    expect(ids).toContain(open.id);
    expect(ids).not.toContain(done.id);
  });

  it('finds one by its number', async () => {
    const ticket = bodyOf<Ticket>(await raise(adminAuth, { customerId: northCustomerId, subject: 'Findable' }));

    const found = await listFor(adminAuth, `?q=${encodeURIComponent(ticket.ticketNo)}`);

    expect(found.map(row => row.id)).toEqual([ticket.id]);
  });
});

describe('working a complaint', () => {
  it('moves it to in progress when it is handed to somebody', async () => {
    const ticket = bodyOf<Ticket>(await raise(adminAuth, { customerId: northCustomerId, subject: 'To assign' }));

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticket.id}/assign`,
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: { assignedTo: northEngineerId },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<Ticket>(response)).toMatchObject({
      status: 'in_progress',
      assignedTo: { id: northEngineerId, name: 'North Engineer' },
    });
  });

  it('refuses to hand one to somebody outside the tenant', async () => {
    const ticket = bodyOf<Ticket>(await raise(adminAuth, { customerId: northCustomerId, subject: 'Bad assignee' }));

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticket.id}/assign`,
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: { assignedTo: randomUUID() },
    });

    expect(response.statusCode).toBe(400);
  });

  it('will not resolve one without saying what was done', async () => {
    const ticket = bodyOf<Ticket>(await raise(adminAuth, { customerId: northCustomerId, subject: 'No resolution' }));

    const response = await patch(adminAuth, ticket.id, { status: 'resolved' });

    expect(response.statusCode, response.body).toBe(400);
  });

  it('stamps the resolution once, and a later edit does not move it', async () => {
    const ticket = bodyOf<Ticket>(await raise(adminAuth, { customerId: northCustomerId, subject: 'To resolve' }));

    const resolved = bodyOf<Ticket>(await patch(adminAuth, ticket.id, {
      status: 'resolved',
      resolution: 'Replaced the drop wire',
    }));
    expect(resolved.resolvedAt).not.toBeNull();

    const closed = bodyOf<Ticket>(await patch(adminAuth, ticket.id, { status: 'closed' }));

    expect(closed.status).toBe('closed');
    expect(closed.resolvedAt).toBe(resolved.resolvedAt);
  });
});

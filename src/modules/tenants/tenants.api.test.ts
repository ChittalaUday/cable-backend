import type { UpiAccount } from './tenant.schema';
import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { rolePermissions, tenantMemberships, tenantUpiAccounts, users } from '@/db/schema';
import { hashPassword } from '@/security/password';
import { PERMISSIONS } from '@/security/permissions';
import { createTestDb } from '@/test/db';
import {
  seedAuthData,
  snapshotRoleGrants,
  TEST_PASSWORD,
  uniqueDeviceId,
  uniqueEmail,
  uniquePhone,
} from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let adminAuth: Record<string, string>;
let collectorAuth: Record<string, string>;
let restoreGrants: () => Promise<void>;
const createdUserIds: string[] = [];

async function signIn(email: string): Promise<Record<string, string>> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'android' },
    payload: { identifier: email, password: TEST_PASSWORD },
  });
  expect(login.statusCode).toBe(200);

  // `active` belongs to two tenants, so every request has to say which.
  return {
    'authorization': `Bearer ${bodyOf(login).accessToken}`,
    'x-tenant-id': data.tenantA.id,
  };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  // A collector holds `payments.collect` and no tenant grant at all — exactly
  // the caller the read route is shaped for. The fixture grants are cut down,
  // so the shipped one is added here and put back in afterAll.
  restoreGrants = await snapshotRoleGrants(db, [SYSTEM_ROLES.STAFF]);
  await db.insert(rolePermissions)
    .values({ roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.PAYMENTS_COLLECT, scope: 'LOCATION' })
    .onConflictDoNothing();

  adminAuth = await signIn(data.active.email);

  const [collector] = await db.insert(users).values({
    email: uniqueEmail('collector'),
    phone: uniquePhone(),
    name: 'Collector',
    passwordHash: await hashPassword(TEST_PASSWORD),
  }).returning();
  createdUserIds.push(collector!.id);
  await db.insert(tenantMemberships).values({
    userId: collector!.id,
    tenantId: data.tenantA.id,
    roleId: SYSTEM_ROLES.STAFF,
  });
  collectorAuth = await signIn(collector!.email!);
});

beforeEach(async () => {
  await db.delete(tenantUpiAccounts).where(eq(tenantUpiAccounts.tenantId, data.tenantA.id));
});

afterAll(async () => {
  await db.delete(tenantUpiAccounts).where(eq(tenantUpiAccounts.tenantId, data.tenantA.id));
  await restoreGrants();
  app.access.invalidate();
  for (const id of createdUserIds)
    await db.delete(users).where(inArray(users.id, [id]));
  await app.close();
  await data.cleanup();
  await close();
});

const vpa = () => `sat${randomUUID().slice(0, 6)}@okhdfc`;

async function add(payload: Record<string, unknown>, auth = adminAuth) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/tenants/me/upi-accounts',
    headers: { ...auth, 'content-type': 'application/json' },
    payload,
  });
}

async function edit(id: string, payload: Record<string, unknown>, auth = adminAuth) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/tenants/me/upi-accounts/${id}`,
    headers: { ...auth, 'content-type': 'application/json' },
    payload,
  });
}

async function list(auth = adminAuth, query = ''): Promise<UpiAccount[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/tenants/me/upi-accounts${query}`,
    headers: auth,
  });
  expect(response.statusCode).toBe(200);

  return bodyOf<UpiAccount[]>(response);
}

describe('the tenant\'s UPI handles', () => {
  it('makes the first handle the default, whatever the body asked for', async () => {
    const response = await add({ upiId: vpa(), payeeName: 'Satya Cable', isDefault: false });

    expect(response.statusCode).toBe(201);
    expect(bodyOf<UpiAccount>(response).isDefault).toBe(true);
  });

  it('keeps exactly one default as handles are added and promoted', async () => {
    await add({ upiId: vpa(), payeeName: 'Counter' });
    const second = bodyOf<UpiAccount>(await add({ upiId: vpa(), payeeName: 'Round', isDefault: true }));

    const accounts = await list();
    expect(accounts.filter(row => row.isDefault).map(row => row.id)).toEqual([second.id]);
  });

  it('shows the default first, so a picker opens on the right one', async () => {
    await add({ upiId: vpa(), payeeName: 'Counter' });
    const second = bodyOf<UpiAccount>(await add({ upiId: vpa(), payeeName: 'Round' }));
    await edit(second.id, { isDefault: true });

    expect((await list())[0]!.id).toBe(second.id);
  });

  it('refuses the same handle twice on one tenant', async () => {
    const handle = vpa();
    await add({ upiId: handle, payeeName: 'Counter' });

    expect((await add({ upiId: handle, payeeName: 'Again' })).statusCode).toBe(409);
  });

  it('refuses a string that is not a handle at all', async () => {
    expect((await add({ upiId: 'not-a-vpa', payeeName: 'Counter' })).statusCode).toBe(400);
    expect((await add({ upiId: 'has space@bank', payeeName: 'Counter' })).statusCode).toBe(400);
  });

  it('keeps a stood-down handle out of what a collector is shown', async () => {
    await add({ upiId: vpa(), payeeName: 'Counter' });
    const spare = bodyOf<UpiAccount>(await add({ upiId: vpa(), payeeName: 'Old round' }));

    expect((await edit(spare.id, { status: 'inactive' })).statusCode).toBe(200);

    expect((await list()).map(row => row.id)).not.toContain(spare.id);
    expect((await list(adminAuth, '?includeInactive=true')).map(row => row.id)).toContain(spare.id);
  });

  it('refuses to stand down the only handle money can arrive at', async () => {
    const only = bodyOf<UpiAccount>(await add({ upiId: vpa(), payeeName: 'Counter' }));

    expect((await edit(only.id, { status: 'inactive' })).statusCode).toBe(409);
  });

  it('passes the default to the oldest survivor when it is removed', async () => {
    const first = bodyOf<UpiAccount>(await add({ upiId: vpa(), payeeName: 'Counter' }));
    await add({ upiId: vpa(), payeeName: 'Round' });
    const third = bodyOf<UpiAccount>(await add({ upiId: vpa(), payeeName: 'Spare', isDefault: true }));

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/me/upi-accounts/${third.id}`,
      headers: adminAuth,
    });
    expect(removed.statusCode).toBe(204);

    const after = await list();
    expect(after.map(row => row.id)).not.toContain(third.id);
    expect(after.find(row => row.isDefault)!.id).toBe(first.id);
  });

  it('lets a collector read the handles but never change them', async () => {
    await add({ upiId: vpa(), payeeName: 'Counter' });

    expect((await list(collectorAuth)).length).toBe(1);
    expect((await add({ upiId: vpa(), payeeName: 'Sneaky' }, collectorAuth)).statusCode).toBe(403);
  });

  it('answers 404 for a handle belonging to another tenant', async () => {
    const response = await edit(randomUUID(), { payeeName: 'Nope' });

    expect(response.statusCode).toBe(404);
  });
});

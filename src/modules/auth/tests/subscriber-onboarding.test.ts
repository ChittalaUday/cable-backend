import type { BuiltApp } from '@/app';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { customers, otpCodes, tenantMemberships, tenants, users } from '@/db/schema';
import { hashOtp } from '@/security/otp';
import { hashPassword } from '@/security/password';
import { normalisePhone } from '@/services/messaging/messaging.service';
import { createTestDb } from '@/test/db';
import { seedRoles, TEST_PASSWORD, uniqueDeviceId, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let tenantId: string;
let otherTenantId: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

const KNOWN_CODE = '424242';

function deviceHeaders(clientDeviceId = uniqueDeviceId()) {
  return {
    'x-device-id': clientDeviceId,
    'x-platform': 'android' as const,
    'x-app-version': '1.0.0',
    'x-os-version': '15',
    'x-device-model': 'Pixel 8',
  };
}

async function importCustomer(phone: string, intoTenant = tenantId): Promise<string> {
  const [row] = await db.insert(customers)
    .values({ tenantId: intoTenant, phone, name: 'Imported Subscriber', customerCode: `C-${randomUUID().slice(0, 8)}` })
    .returning({ id: customers.id });

  return row!.id;
}

async function signInByOtp(phone: string) {
  const identifier = normalisePhone(phone, '91');
  await db.delete(otpCodes).where(eq(otpCodes.identifier, identifier));

  await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });

  await db.update(otpCodes)
    .set({ codeHash: hashOtp(KNOWN_CODE, identifier) })
    .where(eq(otpCodes.identifier, identifier));

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    headers: deviceHeaders(),
    payload: { phone, code: KNOWN_CODE },
  });

  expect(response.statusCode).toBe(200);

  const body = bodyOf(response);
  createdUserIds.push(body.user.id);

  return { response, body };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await seedRoles(db);

  const code = () => `T${randomUUID().slice(0, 4).toUpperCase()}`;
  const [a] = await db.insert(tenants).values({ code: code(), name: 'Alpha Cable' }).returning();
  const [b] = await db.insert(tenants).values({ code: code(), name: 'Beta Broadband' }).returning();
  tenantId = a!.id;
  otherTenantId = b!.id;
  createdTenantIds.push(a!.id, b!.id);
});

afterAll(async () => {
  if (createdUserIds.length > 0)
    await db.delete(users).where(inArray(users.id, createdUserIds));

  await db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
  await app.close();
  await close();
});

describe('subscriber onboarding', () => {
  it('links the imported record and mints the membership on first sign-in', async () => {
    const phone = uniquePhone();
    const customerId = await importCustomer(phone);

    const { response, body } = await signInByOtp(phone);

    expect(response.statusCode).toBe(200);
    expect(body.memberships).toEqual([
      expect.objectContaining({ tenantId, roleId: SYSTEM_ROLES.CUSTOMER }),
    ]);

    const [linked] = await db.select({ userId: customers.userId })
      .from(customers)
      .where(eq(customers.id, customerId));

    expect(linked!.userId).toBe(body.user.id);
  });

  it('returns that subscriber only themselves, and 404s a stranger', async () => {
    const phone = uniquePhone();
    const mine = await importCustomer(phone);
    const stranger = await importCustomer(uniquePhone());

    const { body } = await signInByOtp(phone);
    const auth = { authorization: `Bearer ${body.accessToken}` };

    const list = await app.inject({ method: 'GET', url: '/api/v1/customers', headers: auth });
    expect(bodyOf<{ items: { id: string }[] }>(list).items.map(item => item.id)).toEqual([mine]);

    const direct = await app.inject({ method: 'GET', url: `/api/v1/customers/${stranger}`, headers: auth });
    expect(direct.statusCode).toBe(404);
  });

  it('links a record imported after the subscriber already signed in', async () => {
    const phone = uniquePhone();

    const first = await signInByOtp(phone);
    expect(first.body.memberships).toEqual([]);

    await importCustomer(phone);
    const second = await signInByOtp(phone);

    expect(second.body.memberships).toEqual([
      expect.objectContaining({ tenantId, roleId: SYSTEM_ROLES.CUSTOMER }),
    ]);
  });

  it('is idempotent across repeated sign-ins', async () => {
    const phone = uniquePhone();
    await importCustomer(phone);

    const { body } = await signInByOtp(phone);
    await signInByOtp(phone);
    await signInByOtp(phone);

    const rows = await db.select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, body.user.id));

    expect(rows).toHaveLength(1);
  });

  it('never downgrades staff who are also subscribers of their own operator', async () => {
    const phone = uniquePhone();
    const email = uniqueEmail('staff-subscriber');

    const [staff] = await db.insert(users)
      .values({ email, phone, name: 'Staff Who Subscribes', passwordHash: await hashPassword(TEST_PASSWORD) })
      .returning();
    createdUserIds.push(staff!.id);

    await db.insert(tenantMemberships)
      .values({ userId: staff!.id, tenantId, roleId: SYSTEM_ROLES.STAFF });

    await importCustomer(phone);
    await importCustomer(phone, otherTenantId);

    await signInByOtp(phone);

    const rows = await db.select({ tenantId: tenantMemberships.tenantId, roleId: tenantMemberships.roleId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, staff!.id));

    expect(rows).toEqual(expect.arrayContaining([
      { tenantId, roleId: SYSTEM_ROLES.STAFF },
      { tenantId: otherTenantId, roleId: SYSTEM_ROLES.CUSTOMER },
    ]));
    expect(rows).toHaveLength(2);
  });

  it('leaves a soft-deleted record unclaimed', async () => {
    const phone = uniquePhone();
    const customerId = await importCustomer(phone);
    await db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, customerId));

    const { body } = await signInByOtp(phone);

    expect(body.memberships).toEqual([]);

    const [row] = await db.select({ userId: customers.userId })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)));

    expect(row!.userId).toBeNull();
  });
});

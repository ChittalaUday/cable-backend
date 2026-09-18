import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { otpCodes, sessions, users } from '@/db/schema';
import { isCheckViolation } from '@/errors/postgres';
import { hashOtp } from '@/security/otp';
import { hashPassword } from '@/security/password';
import { normalisePhone } from '@/services/messaging/messaging.service';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';
import { normaliseEmail } from '@/utils/email';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;

const KNOWN_CODE = '424242';

function deviceHeaders(clientDeviceId: string) {
  return {
    'x-device-id': clientDeviceId,
    'x-platform': 'ios',
    'x-app-version': '1.0.0',
    'x-os-version': '18.0',
    'x-device-model': 'iPhone16,1',
  };
}

async function issueOtp(phone: string, code = KNOWN_CODE) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone },
  });

  const identifier = normalisePhone(phone, '91');
  await db.update(otpCodes)
    .set({ codeHash: hashOtp(code, identifier) })
    .where(eq(otpCodes.identifier, identifier));

  return response;
}

async function login(email: string, password: string, clientDeviceId = uniqueDeviceId()) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: deviceHeaders(clientDeviceId),
    payload: { identifier: email, password },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);
});

afterAll(async () => {
  await data.cleanup();
  await app.close();
  await close();
});

describe('health', () => {
  it('answers at the root for load balancers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({ status: 'ok' });
  });

  it('answers under the version prefix for clients that only know baseUrl', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({ status: 'ok', version: 'v1' });
  });

  it('needs no token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).not.toBe(401);
  });
});

describe('password login', () => {
  it('issues tokens and never returns the password hash', async () => {
    const response = await login(data.active.email, data.password);
    const body = bodyOf(response);

    expect(response.statusCode).toBe(200);
    expect(body.tokenType).toBe('Bearer');
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.id).toBe(data.active.id);
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.user).not.toHaveProperty('googleSub');
  });

  it('answers with the memberships, so a client need not call /auth/me to render', async () => {
    const body = bodyOf(await login(data.active.email, data.password));

    const byTenant = Object.fromEntries(body.memberships.map(m => [m.tenantId, m.roleId]));

    expect(byTenant[data.tenantA.id]).toBe('admin');
    expect(byTenant[data.tenantB.id]).toBe('customer');

    expect(body.memberships.find(m => m.tenantId === data.tenantA.id)?.tenantName).toBe('Alpha Cable');
  });

  it('signs in whatever case the address was typed in, on either side', async () => {
    const address = `Mixed.Case-${randomUUID().slice(0, 8)}@Test.Local`;
    const [stored] = await db.insert(users).values({
      email: normaliseEmail(address),
      name: 'Mixed Case',
      passwordHash: await hashPassword(TEST_PASSWORD),
    }).returning();

    try {
      expect(stored!.email).toBe(address.toLowerCase());

      for (const typed of [address, address.toLowerCase(), address.toUpperCase(), ` ${address} `]) {
        const response = await login(typed, TEST_PASSWORD);

        expect(response.statusCode, `${typed}: ${response.body}`).toBe(200);
        expect(bodyOf(response).user.id).toBe(stored!.id);
      }
    }
    finally {
      await db.delete(users).where(eq(users.id, stored!.id));
    }
  });

  it('refuses to store an address in any other form, so the two rules cannot drift', async () => {
    const refused = await db
      .insert(users)
      .values({ email: 'Not.Normalised@Example.COM', name: 'refused' })
      .catch((error: unknown) => error);

    expect(isCheckViolation(refused)).toBe(true);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const wrongPassword = await login(data.active.email, 'not-the-password');
    const noSuchUser = await login('nobody-at-all@test.local', 'not-the-password');

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    expect(bodyOf(wrongPassword).code).toBe('AUTH_CREDENTIALS_INVALID');
    expect(bodyOf(noSuchUser).code).toBe(bodyOf(wrongPassword).code);
    expect(bodyOf(noSuchUser).message).toBe(bodyOf(wrongPassword).message);
  });

  it('tells a Google-only account apart from a wrong password', async () => {
    const response = await login(data.googleOnly.email, data.password);

    expect(response.statusCode).toBe(401);
    expect(bodyOf(response).code).toBe('AUTH_PASSWORD_NOT_SET');
  });

  it('refuses a disabled account even with the right password', async () => {
    const response = await login(data.disabled.email, data.password);

    expect(response.statusCode).toBe(403);
    expect(bodyOf(response).code).toBe('AUTH_ACCOUNT_DISABLED');
  });

  it('refuses a blocked device before issuing anything', async () => {
    const response = await login(data.active.email, data.password, data.blockedDeviceId);

    expect(response.statusCode).toBe(403);
    expect(bodyOf(response).code).toBe('AUTH_DEVICE_BLOCKED');
  });

  it('requires the device headers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: data.active.email, password: data.password },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('otp login', () => {
  it('answers 202 for a number that has no account', async () => {
    const response = await issueOtp(data.unknownPhone);

    expect(response.statusCode).toBe(202);
    expect(bodyOf(response).status).toBe('accepted');
  });

  it('creates the account on first successful verify', async () => {
    const phone = uniquePhone();
    await issueOtp(phone);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: deviceHeaders(uniqueDeviceId()),
      payload: { phone, code: KNOWN_CODE },
    });

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response).user.phone).toBe(phone);

    await db.delete(users).where(eq(users.phone, phone));
  });

  it('answers with the memberships too, so an OTP sign-in can pick a tenant', async () => {
    await issueOtp(data.active.phone);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: deviceHeaders(uniqueDeviceId()),
      payload: { phone: data.active.phone, code: KNOWN_CODE },
    });

    expect(response.statusCode).toBe(200);

    const byTenant = Object.fromEntries(
      bodyOf(response).memberships.map((m: { tenantId: string; roleId: string }) => [m.tenantId, m.roleId]),
    );
    expect(byTenant[data.tenantA.id]).toBe('admin');
    expect(byTenant[data.tenantB.id]).toBe('customer');
    expect(bodyOf(response).memberships.find((m: { tenantId: string }) => m.tenantId === data.tenantA.id)?.tenantName)
      .toBe('Alpha Cable');
  });

  it('counts a wrong code against the attempt cap', async () => {
    const phone = uniquePhone();
    await issueOtp(phone);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: deviceHeaders(uniqueDeviceId()),
      payload: { phone, code: '000000' },
    });

    expect(response.statusCode).toBe(401);
    expect(bodyOf(response).code).toBe('OTP_INVALID');

    const [row] = await db.select().from(otpCodes).where(eq(otpCodes.identifier, normalisePhone(phone, '91')));
    expect(row!.attempts).toBe(1);
  });

  it('refuses a code that was already consumed', async () => {
    const phone = uniquePhone();
    await issueOtp(phone);

    const verify = async () => app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: deviceHeaders(uniqueDeviceId()),
      payload: { phone, code: KNOWN_CODE },
    });

    expect((await verify()).statusCode).toBe(200);

    const replay = await verify();
    expect(replay.statusCode).toBe(401);
    expect(bodyOf(replay).code).toBe('OTP_EXPIRED');

    await db.delete(users).where(eq(users.phone, phone));
  });

  it('refuses an expired code', async () => {
    const phone = uniquePhone();
    await issueOtp(phone);
    await db.update(otpCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(otpCodes.identifier, normalisePhone(phone, '91')));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: deviceHeaders(uniqueDeviceId()),
      payload: { phone, code: KNOWN_CODE },
    });

    expect(response.statusCode).toBe(401);
    expect(bodyOf(response).code).toBe('OTP_EXPIRED');
  });

  it('enforces the resend cooldown', async () => {
    const phone = uniquePhone();
    await issueOtp(phone);

    const tooSoon = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone },
    });

    expect(tooSoon.statusCode).toBe(400);
    expect(bodyOf(tooSoon).code).toBe('OTP_RESEND_TOO_SOON');
  });

  it('kills the previous code when a new one is issued', async () => {
    const phone = uniquePhone();
    await issueOtp(phone, '111111');

    await db.update(otpCodes)
      .set({ lastSentAt: new Date(Date.now() - 600_000) })
      .where(eq(otpCodes.identifier, phone));

    await issueOtp(phone, '222222');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: deviceHeaders(uniqueDeviceId()),
      payload: { phone, code: '111111' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('binds a code to the number it was issued for', async () => {
    const mine = uniquePhone();
    const theirs = uniquePhone();
    await issueOtp(mine);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: deviceHeaders(uniqueDeviceId()),
      payload: { phone: theirs, code: KNOWN_CODE },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('access token', () => {
  it('carries every active membership and no suspended one', async () => {
    const { accessToken } = bodyOf((await login(data.active.email, data.password)));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const tenantIds = bodyOf(response).memberships.map((m: { tenantId: string }) => m.tenantId);
    expect(tenantIds).toHaveLength(2);
    expect(tenantIds).toContain(data.tenantA.id);
    expect(tenantIds).toContain(data.tenantB.id);
  });

  it('keeps the two roles of one user apart', async () => {
    const { accessToken } = bodyOf((await login(data.active.email, data.password)));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const byTenant = Object.fromEntries(
      bodyOf(response).memberships.map((m: { tenantId: string; roleId: string }) => [m.tenantId, m.roleId]),
    );

    expect(byTenant[data.tenantA.id]).toBe('admin');
    expect(byTenant[data.tenantB.id]).toBe('customer');
  });

  it('refuses a missing header', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(bodyOf(response).code).toBe('AUTH_HEADER_MISSING');
  });

  it('refuses a token that is not a token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer not-a-jwt' },
    });

    expect(response.statusCode).toBe(401);
    expect(bodyOf(response).code).toBe('AUTH_TOKEN_INVALID');
  });

  it('refuses a token signed with the wrong key', async () => {
    const { SignJWT } = await import('jose');
    const forged = await new SignJWT({ sub: data.active.id, sid: 'x', did: 'y', memberships: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('cable-backend')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-different-secret-that-is-32-chars!!'));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('refresh rotation', () => {
  it('returns a different refresh token each time', async () => {
    const first = bodyOf((await login(data.active.email, data.password)));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response).refreshToken).not.toBe(first.refreshToken);
  });

  it('revokes the session when a rotated token is replayed', async () => {
    const { refreshToken, accessToken } = bodyOf((await login(data.active.email, data.password)));

    await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken },
    });

    expect(replay.statusCode).toBe(401);
    expect(bodyOf(replay).code).toBe('AUTH_REFRESH_REUSED');

    const afterReplay = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(afterReplay.statusCode).toBe(401);
    expect(bodyOf(afterReplay).code).toBe('AUTH_SESSION_REVOKED');
  });

  it('refuses a refresh token that was never issued', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: 'a'.repeat(43) },
    });

    expect(response.statusCode).toBe(401);
    expect(bodyOf(response).code).toBe('AUTH_REFRESH_INVALID');
  });
});

describe('logout', () => {
  it('kills the access token immediately, not at expiry', async () => {
    const { accessToken } = bodyOf((await login(data.active.email, data.password)));
    const authorization = `Bearer ${accessToken}`;

    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization } })).statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { authorization } });

    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization } });
    expect(after.statusCode).toBe(401);
    expect(bodyOf(after).code).toBe('AUTH_SESSION_REVOKED');
  });

  it('leaves another account on the same device signed in', async () => {
    const sharedDevice = uniqueDeviceId();
    const mine = bodyOf((await login(data.active.email, data.password, sharedDevice)));
    const theirs = bodyOf((await login(data.other.email, data.password, sharedDevice)));

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${mine.accessToken}` },
    });

    const stillIn = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${theirs.accessToken}` },
    });

    expect(stillIn.statusCode).toBe(200);
  });

  it('signs out every device with logout-all', async () => {
    const one = bodyOf((await login(data.active.email, data.password)));
    const two = bodyOf((await login(data.active.email, data.password)));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: { authorization: `Bearer ${one.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response).revokedSessions).toBeGreaterThanOrEqual(2);

    const other = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${two.accessToken}` },
    });

    expect(other.statusCode).toBe(401);
  });

  it('revokes rather than deletes, so the reason survives', async () => {
    const { accessToken } = bodyOf((await login(data.active.email, data.password)));

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const sessionId = bodyOf(me).sessionId;

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row).toBeDefined();
    expect(row!.revokedReason).toBe('logout');
  });
});

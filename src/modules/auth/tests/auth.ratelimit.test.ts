import type { FastifyInstance } from 'fastify';
import type { BuiltApp } from '@/app';
import rateLimit from '@fastify/rate-limit';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { otpCodes, users } from '@/db/schema';
import { hashOtp } from '@/security/otp';
import { normalisePhone } from '@/services/messaging/messaging.service';
import { createTestDb } from '@/test/db';
import { uniqueDeviceId, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';
import { identifierKey, perIdentifier } from '../auth.ratelimit';

const { db, close } = createTestDb();

let app: BuiltApp;

function deviceHeaders(clientDeviceId: string) {
  return {
    'x-device-id': clientDeviceId,
    'x-platform': 'ios',
    'x-app-version': '1.0.0',
    'x-os-version': '18.0',
    'x-device-model': 'iPhone16,1',
  };
}

async function issueOtp(phone: string, code = '424242', maxAttempts = 3) {
  const normalised = normalisePhone(phone, '91');
  await db.insert(otpCodes).values({
    identifier: normalised,
    channel: 'whatsapp',
    codeHash: hashOtp(code, normalised),
    maxAttempts,
    expiresAt: new Date(Date.now() + 300_000),
  });
}

async function requestOtp(phone: string) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
}

async function verifyOtp(phone: string, code: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    headers: deviceHeaders(uniqueDeviceId()),
    payload: { phone, code },
  });
}

/** Pretend the last code went out `seconds` ago, so a cooldown can be waited out. */
async function age(phone: string, seconds: number) {
  await db.update(otpCodes)
    .set({ lastSentAt: new Date(Date.now() - seconds * 1000) })
    .where(eq(otpCodes.identifier, normalisePhone(phone, '91')));
}

async function setLiveCode(phone: string, code: string) {
  const normalised = normalisePhone(phone, '91');
  await db.update(otpCodes)
    .set({ codeHash: hashOtp(code, normalised) })
    .where(eq(otpCodes.identifier, normalised));
}

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await close();
});

describe('otp verification retries and attempt limits', () => {
  it('reports remaining retry attempts on wrong code and blocks after max attempts', async () => {
    const phone = uniquePhone();
    await issueOtp(phone, '999999', 3);

    const attempt1 = await verifyOtp(phone, '000001');
    expect(attempt1.statusCode).toBe(401);
    expect(bodyOf(attempt1).code).toBe('OTP_INVALID');
    expect(bodyOf(attempt1).message).toContain('2 attempts remaining');

    const attempt2 = await verifyOtp(phone, '000002');
    expect(attempt2.statusCode).toBe(401);
    expect(bodyOf(attempt2).code).toBe('OTP_INVALID');
    expect(bodyOf(attempt2).message).toContain('1 attempt remaining');

    const attempt3 = await verifyOtp(phone, '000003');
    expect(attempt3.statusCode).toBe(400);
    expect(bodyOf(attempt3).code).toBe('OTP_TOO_MANY_ATTEMPTS');

    // Even the right code is refused once the cap is spent.
    const attempt4 = await verifyOtp(phone, '999999');
    expect(attempt4.statusCode).toBe(400);
    expect(bodyOf(attempt4).code).toBe('OTP_TOO_MANY_ATTEMPTS');
  });

  it('allows requesting a new OTP after cooldown even if previous code had too many attempts', async () => {
    const phone = uniquePhone();
    await issueOtp(phone, '123456', 2);

    await verifyOtp(phone, '000001');
    const spent = await verifyOtp(phone, '000002');
    expect(spent.statusCode).toBe(400);
    expect(bodyOf(spent).code).toBe('OTP_TOO_MANY_ATTEMPTS');

    await age(phone, 70);

    const requestNew = await requestOtp(phone);
    expect(requestNew.statusCode).toBe(202);
    expect(bodyOf(requestNew).status).toBe('accepted');
  });
});

describe('escalating otp resend cooldown', () => {
  it('tells the caller how long the next resend costs, and lengthens it each time', async () => {
    const phone = uniquePhone();

    const first = await requestOtp(phone);
    expect(first.statusCode).toBe(202);
    expect(bodyOf(first).nextCooldownSeconds).toBe(60);

    const tooSoon = await requestOtp(phone);
    expect(tooSoon.statusCode).toBe(400);
    expect(bodyOf(tooSoon).code).toBe('OTP_RESEND_TOO_SOON');

    await age(phone, 61);
    const second = await requestOtp(phone);
    expect(second.statusCode).toBe(202);
    expect(bodyOf(second).nextCooldownSeconds).toBe(120);

    // The 60s that bought a resend a moment ago is no longer enough.
    await age(phone, 61);
    const stillTooSoon = await requestOtp(phone);
    expect(stillTooSoon.statusCode).toBe(400);
    expect(bodyOf(stillTooSoon).code).toBe('OTP_RESEND_TOO_SOON');
    expect(bodyOf(stillTooSoon).message).toContain('59 seconds');

    await age(phone, 121);
    const third = await requestOtp(phone);
    expect(third.statusCode).toBe(202);
    expect(bodyOf(third).nextCooldownSeconds).toBe(180);
  });

  it('drops back to the first rung once a code is actually verified', async () => {
    const phone = uniquePhone();

    await requestOtp(phone);
    await age(phone, 61);
    const second = await requestOtp(phone);
    expect(bodyOf(second).nextCooldownSeconds).toBe(120);

    await setLiveCode(phone, '424242');
    const verified = await verifyOtp(phone, '424242');
    expect(verified.statusCode).toBe(200);

    // 61s would still be too short on the 120s rung — the verify reset it.
    await age(phone, 61);
    const afterVerify = await requestOtp(phone);
    expect(afterVerify.statusCode).toBe(202);
    expect(bodyOf(afterVerify).nextCooldownSeconds).toBe(60);

    await db.delete(users).where(eq(users.phone, phone));
  });

  it('caps the ladder at five rungs, within the resend_attempts check constraint', async () => {
    const phone = uniquePhone();
    const ladder: number[] = [];

    for (let rung = 0; rung < 6; rung++) {
      await age(phone, 10_000);
      const response = await requestOtp(phone);
      expect(response.statusCode).toBe(202);
      ladder.push(bodyOf(response).nextCooldownSeconds);
    }

    expect(ladder).toEqual([60, 120, 180, 240, 300, 60]);

    const rows = await db.select({ resendAttempts: otpCodes.resendAttempts })
      .from(otpCodes)
      .where(eq(otpCodes.identifier, normalisePhone(phone, '91')));

    expect(rows.every(row => row.resendAttempts >= 0 && row.resendAttempts <= 5)).toBe(true);
  });
});

describe('per-identifier rate limiting', () => {
  it('keys on the account named in the body, and on the caller when there is none', () => {
    const key = identifierKey({ prefix: 'login', field: 'identifier' });

    expect(key({ body: { identifier: '  Admin@Example.COM  ' }, ip: '10.0.0.1' } as never)).toBe('login:admin@example.com');
    expect(key({ body: { identifier: '' }, ip: '10.0.0.1' } as never)).toBe('login:10.0.0.1');
    expect(key({ body: {}, ip: '10.0.0.1' } as never)).toBe('login:10.0.0.1');
    expect(key({ ip: '10.0.0.1' } as never)).toBe('login:10.0.0.1');
  });

  /** The production wiring: a per-IP ceiling on the route, a per-account one on top. */
  async function probeApp(ipMax: number, identifierMax: number): Promise<FastifyInstance> {
    const testApp = Fastify();

    await testApp.register(rateLimit, {
      global: true,
      max: ipMax,
      timeWindow: '1 minute',
      keyGenerator: request => request.ip,
    });

    testApp.setErrorHandler((error: { statusCode?: number; code?: string; message: string }, _request, reply) =>
      reply.status(error.statusCode ?? 500).send({ code: error.code, message: error.message }));

    testApp.post('/probe', {
      config: { rateLimit: { max: ipMax, timeWindow: '1 minute' }, public: true },
      preValidation: perIdentifier(testApp, {
        prefix: 'otp-verify',
        field: 'phone',
        max: identifierMax,
        timeWindow: 60_000,
        message: 'Too many OTP verification attempts.',
      }),
    }, async (_request, reply) => reply.send({ ok: true }));

    await testApp.ready();
    return testApp;
  }

  it('stops one account well before the shared IP ceiling, and leaves other accounts alone', async () => {
    const testApp = await probeApp(1000, 2);
    const phone = uniquePhone();

    const call = async (to: string) => testApp.inject({ method: 'POST', url: '/probe', payload: { phone: to } });

    expect((await call(phone)).statusCode).toBe(200);
    expect((await call(phone)).statusCode).toBe(200);

    const blocked = await call(phone);
    expect(blocked.statusCode).toBe(429);
    expect(bodyOf(blocked).code).toBe('RATE_LIMIT_EXCEEDED');
    expect(bodyOf(blocked).message).toContain('Too many OTP verification attempts');

    expect((await call(uniquePhone())).statusCode).toBe(200);

    await testApp.close();
  });

  /**
   * The regression this wiring exists for. @fastify/rate-limit runs at most one
   * of its own hooks per request, so a route that declared the per-account key
   * as `config.rateLimit` silently gave up its per-IP ceiling — and an attacker
   * rotating phone numbers from one host met no limit at all.
   */
  it('still holds the per-IP ceiling when the caller rotates identifiers', async () => {
    const testApp = await probeApp(3, 1000);

    const codes: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await testApp.inject({ method: 'POST', url: '/probe', payload: { phone: uniquePhone() } });
      codes.push(response.statusCode);
    }

    expect(codes).toEqual([200, 200, 200, 429]);

    await testApp.close();
  });
});

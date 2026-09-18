import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { devices, sessions, users } from '@/db/schema';
import { hashPassword } from '@/security/password';
import { createTestDb } from '@/test/db';
import { seedAuthData, uniqueDeviceId, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;

function deviceHeaders(clientDeviceId: string) {
  return { 'x-device-id': clientDeviceId, 'x-platform': 'ios' as const };
}

async function login(email: string, password: string, clientDeviceId = uniqueDeviceId()) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: deviceHeaders(clientDeviceId),
    payload: { identifier: email, password },
  });
  return { status: response.statusCode, body: bodyOf(response) };
}

async function withUserPatch(
  patch: Partial<typeof users.$inferInsert>,
  restore: Partial<typeof users.$inferInsert>,
  body: () => Promise<void>,
): Promise<void> {
  await db.update(users).set(patch).where(eq(users.id, data.active.id));
  try {
    await body();
  }
  finally {
    await db.update(users).set(restore).where(eq(users.id, data.active.id));
  }
}

async function refresh(refreshToken: string) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });
}

async function me(accessToken: string) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${accessToken}` },
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

describe('credentials changed out of band', () => {
  it('refuses to refresh a session older than the last credential change', async () => {
    const { body } = await login(data.active.email, data.password);

    await withUserPatch(
      { passwordHash: await hashPassword('a-different-password'), credentialsChangedAt: new Date() },
      { passwordHash: await hashPassword(data.password), credentialsChangedAt: new Date(0) },
      async () => {
        const response = await refresh(body.refreshToken);

        expect(response.statusCode).toBe(401);
        expect(bodyOf(response).code).toBe('AUTH_SESSION_REVOKED');
      },
    );
  });

  it('records why the session died, so support can explain it', async () => {
    const { body } = await login(data.active.email, data.password);
    const { sessionId } = bodyOf(await me(body.accessToken));

    await withUserPatch({ credentialsChangedAt: new Date() }, { credentialsChangedAt: new Date(0) }, async () => {
      await refresh(body.refreshToken);

      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(row!.revokedReason).toBe('credentials_changed');
    });
  });

  it('leaves a session issued after the change alone', async () => {
    await withUserPatch({ credentialsChangedAt: new Date() }, { credentialsChangedAt: new Date(0) }, async () => {
      const { body } = await login(data.active.email, data.password);
      const response = await refresh(body.refreshToken);

      expect(response.statusCode).toBe(200);
    });
  });
});

describe('blocked device', () => {
  it('stops a session that was already signed in on it', async () => {
    const clientDeviceId = uniqueDeviceId();
    const { body } = await login(data.active.email, data.password, clientDeviceId);

    await db.update(devices).set({ blockedAt: new Date() }).where(eq(devices.clientDeviceId, clientDeviceId));

    const response = await refresh(body.refreshToken);

    expect(response.statusCode).toBe(403);
    expect(bodyOf(response).code).toBe('AUTH_DEVICE_BLOCKED');

    await db.delete(devices).where(eq(devices.clientDeviceId, clientDeviceId));
  });

  it('kills the access token too, not just the refresh', async () => {
    const clientDeviceId = uniqueDeviceId();
    const { body } = await login(data.active.email, data.password, clientDeviceId);

    await db.update(devices).set({ blockedAt: new Date() }).where(eq(devices.clientDeviceId, clientDeviceId));
    await refresh(body.refreshToken);

    const response = await me(body.accessToken);

    expect(response.statusCode).toBe(401);
    expect(bodyOf(response).code).toBe('AUTH_SESSION_REVOKED');

    await db.delete(devices).where(eq(devices.clientDeviceId, clientDeviceId));
  });
});

describe('account enumeration', () => {
  it('takes comparable time for an unknown account and a wrong password', async () => {
    const time = async (email: string) => {
      const started = process.hrtime.bigint();
      await login(email, 'definitely-the-wrong-password');
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    await time(data.active.email);

    const known = Math.min(...await Promise.all([1, 2, 3].map(async () => time(data.active.email))));
    const unknown = Math.min(...await Promise.all([1, 2, 3].map(async () => time(`ghost-${Date.now()}@test.local`))));

    expect(unknown).toBeGreaterThan(known / 3);
  });

  it('does not look an email up as a phone number', async () => {
    const collidingPhone = uniquePhone();
    const digits = collidingPhone.slice(2);

    await withUserPatch({ phone: collidingPhone }, { phone: data.active.phone }, async () => {
      const response = await login(`user${digits}@nowhere.test`, data.password);

      expect(response.status).toBe(401);
    });
  });

  it('still signs in by phone when the identifier really is a phone', async () => {
    const response = await login(data.active.phone, data.password);

    expect(response.status).toBe(200);
  });
});

describe('a rotation whose answer never arrived', () => {
  /** Push the last rotation back in time, so the grace window has passed. */
  async function ageRotation(userId: string, seconds: number) {
    await db.update(sessions)
      .set({ lastUsedAt: new Date(Date.now() - seconds * 1000) })
      .where(eq(sessions.userId, userId));
  }

  it('serves a retry of the consumed token instead of signing the user out', async () => {
    const { body } = await login(data.active.email, data.password);

    const rotated = await refresh(body.refreshToken);
    expect(rotated.statusCode).toBe(200);

    // The phone never saw that answer, so it asks again with the token it kept.
    const retry = await refresh(body.refreshToken);
    expect(retry.statusCode).toBe(200);

    // And what comes back actually works — otherwise the retry bought nothing.
    const third = await refresh(bodyOf(retry).refreshToken);
    expect(third.statusCode).toBe(200);
  });

  it('does not let repeated retries slide the window forward', async () => {
    const { body } = await login(data.active.email, data.password);
    await refresh(body.refreshToken);

    // Two graced retries, then the window expires measured from the FIRST
    // rotation — not from the most recent retry.
    expect((await refresh(body.refreshToken)).statusCode).toBe(200);
    expect((await refresh(body.refreshToken)).statusCode).toBe(200);

    await ageRotation(data.active.id, 120);

    const late = await refresh(body.refreshToken);
    expect(late.statusCode).toBe(401);
    expect(bodyOf(late).code).toBe('AUTH_REFRESH_REUSED');
  });

  it('still treats a replay after the window as theft and kills the session', async () => {
    const { body } = await login(data.active.email, data.password);

    const rotated = await refresh(body.refreshToken);
    const live = bodyOf(rotated).refreshToken;

    await ageRotation(data.active.id, 120);

    const replay = await refresh(body.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(bodyOf(replay).code).toBe('AUTH_REFRESH_REUSED');

    // The whole session goes, so the token the thief did not have dies too.
    const after = await refresh(live);
    expect(after.statusCode).toBe(401);
  });
});

describe('refresh rotation is atomic', () => {
  it('lets exactly one of two concurrent rotations win', async () => {
    const { body } = await login(data.active.email, data.password);

    const results = await Promise.all([
      refresh(body.refreshToken),
      refresh(body.refreshToken),
    ]);

    const ok = results.filter(r => r.statusCode === 200);

    expect(ok).toHaveLength(1);
  });

  it('does not leave two usable refresh tokens behind', async () => {
    const { body } = await login(data.active.email, data.password);

    const results = await Promise.all([
      refresh(body.refreshToken),
      refresh(body.refreshToken),
    ]);

    const issued = results
      .filter(r => r.statusCode === 200)
      .map(r => bodyOf(r).refreshToken);

    const reused = await Promise.all(issued.map(async token => (await refresh(token)).statusCode));

    expect(reused.filter(code => code === 200)).toHaveLength(1);
  });
});

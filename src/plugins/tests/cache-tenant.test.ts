import type { BuiltApp } from '@/app';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { tenantMemberships, users } from '@/db/schema';
import { hashPassword } from '@/security/password';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let cleanup: () => Promise<void>;
let soloAuth: Record<string, string>;
let multiAuth: Record<string, string>;
let schemaId: string;

const createdUserIds: string[] = [];
const unique = () => randomUUID().slice(0, 8);

async function signIn(email: string): Promise<Record<string, string>> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: email, password: TEST_PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);

  return { authorization: `Bearer ${bodyOf(login).accessToken}` };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const data = await seedAuthData(db);
  cleanup = data.cleanup;

  multiAuth = { ...(await signIn(data.active.email)), 'x-tenant-id': data.tenantA.id };

  const [solo] = await db
    .insert(users)
    .values({
      email: uniqueEmail('solo'),
      phone: uniquePhone(),
      name: 'Solo Admin',
      passwordHash: await hashPassword(TEST_PASSWORD),
    })
    .returning();
  await db.insert(tenantMemberships).values({
    userId: solo!.id,
    tenantId: data.tenantA.id,
    roleId: SYSTEM_ROLES.ADMIN,
  });
  createdUserIds.push(solo!.id);
  soloAuth = await signIn(solo!.email!);

  const write = { ...multiAuth, 'content-type': 'application/json' };
  const category = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/location-categories',
    headers: write,
    payload: { name: 'Area', slug: `area-${unique()}` },
  }));
  schemaId = bodyOf<{ id: string }>(await app.inject({
    method: 'POST',
    url: '/api/v1/location-schemas',
    headers: write,
    payload: { name: 'Flat', slug: `flat-${unique()}`, levels: [{ categoryId: category.id }] },
  })).id;
});

afterAll(async () => {
  await app.close();
  await db.delete(users).where(inArray(users.id, createdUserIds));
  await cleanup();
  await close();
});

async function listAsSolo(): Promise<{ cache: string | undefined; names: string[] }> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/locations?limit=100', headers: soloAuth });
  expect(response.statusCode, response.body).toBe(200);

  return {
    cache: response.headers['x-cache'] as string | undefined,
    names: bodyOf<{ items: { name: string }[] }>(response).items.map(item => item.name),
  };
}

describe('cache tenant namespace', () => {
  it('serves a repeated read from the cache', async () => {
    expect((await listAsSolo()).cache).toBe('MISS');
    expect((await listAsSolo()).cache).toBe('HIT');
  });

  it('invalidates a single-tenant caller\'s page when a multi-tenant caller writes', async () => {
    await listAsSolo();
    expect((await listAsSolo()).cache).toBe('HIT');

    const added = `Namespace Probe ${unique()}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { ...multiAuth, 'content-type': 'application/json' },
      payload: { schemaId, name: added },
    });
    expect(created.statusCode, created.body).toBe(201);

    const after = await listAsSolo();

    expect(after.cache).toBe('MISS');
    expect(after.names).toContain(added);
  });

  it('invalidates a multi-tenant caller\'s page when a single-tenant caller writes', async () => {
    const listAsMulti = async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/locations?limit=100', headers: multiAuth });
      expect(response.statusCode, response.body).toBe(200);
      return {
        cache: response.headers['x-cache'] as string | undefined,
        names: bodyOf<{ items: { name: string }[] }>(response).items.map(item => item.name),
      };
    };

    await listAsMulti();
    expect((await listAsMulti()).cache).toBe('HIT');

    const added = `Namespace Probe ${unique()}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { ...soloAuth, 'content-type': 'application/json' },
      payload: { schemaId, name: added },
    });
    expect(created.statusCode, created.body).toBe(201);

    const after = await listAsMulti();

    expect(after.cache).toBe('MISS');
    expect(after.names).toContain(added);
  });
  it('leaves another tag alone when a write drops one', async () => {
    const packages = async () => app.inject({ method: 'GET', url: '/api/v1/packages?limit=10', headers: soloAuth });

    expect((await packages()).headers['x-cache']).toBe('MISS');
    expect((await packages()).headers['x-cache']).toBe('HIT');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { ...multiAuth, 'content-type': 'application/json' },
      payload: { schemaId, name: `Tag Probe ${unique()}` },
    });
    expect(created.statusCode, created.body).toBe(201);

    expect((await listAsSolo()).cache).toBe('MISS');
    expect((await packages()).headers['x-cache']).toBe('HIT');
  });

  it('never caches an error', async () => {
    const url = `/api/v1/locations/${randomUUID()}`;

    const first = await app.inject({ method: 'GET', url, headers: soloAuth });
    expect(first.statusCode).toBe(404);
    expect(first.headers['x-cache']).toBeUndefined();

    const second = await app.inject({ method: 'GET', url, headers: soloAuth });
    expect(second.statusCode).toBe(404);
    expect(second.headers['x-cache']).toBeUndefined();
  });
});

import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let auth: Record<string, string>;

interface Service { id: string; name: string; slug: string; providerCount: number; status: string; providers: Provider[] }
interface Provider { id: string; serviceId: string; name: string; slug: string; isDefault: boolean; packageCount: number }

const unique = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: data.active.email, password: TEST_PASSWORD },
  });

  auth = { 'authorization': `Bearer ${bodyOf(login).accessToken}`, 'x-tenant-id': data.tenantA.id };
});

afterAll(async () => {
  await app.close();
  await data.cleanup();
  await close();
});

async function createService(overrides: Record<string, unknown> = {}) {
  const slug = `cable-${unique()}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/services',
    headers: auth,
    payload: { name: 'Cable TV', slug, icon: 'tv', ...overrides },
  });

  expect(response.statusCode).toBe(201);
  return bodyOf<Service>(response);
}

async function createProvider(serviceId: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/service-providers',
    headers: auth,
    payload: { serviceId, name: 'ACT Digital', slug: `act-${unique()}`, ...payload },
  });
}

describe('service catalogue', () => {
  it('counts the providers that deliver a service', async () => {
    const service = await createService();
    expect(service.providerCount).toBe(0);

    await createProvider(service.id);
    await createProvider(service.id, { name: 'Hathway', slug: `hathway-${unique()}` });

    const read = bodyOf<Service>(await app.inject({
      method: 'GET',
      url: `/api/v1/services/${service.id}`,
      headers: auth,
    }));

    expect(read.providerCount).toBe(2);
    expect(read.providers).toHaveLength(2);
    expect(read.providers.map(p => p.name).sort()).toEqual(['ACT Digital', 'Hathway']);
  });

  it('counts them on the list too, not only on the detail', async () => {
    const service = await createService();
    await createProvider(service.id);
    await createProvider(service.id, { name: 'Hathway', slug: `hathway-${unique()}` });

    const listed = bodyOf<Service[]>(await app.inject({
      method: 'GET',
      url: '/api/v1/services',
      headers: auth,
    })).find(item => item.id === service.id);

    expect(listed?.providerCount).toBe(2);
  });

  it('counts each provider’s packages on the service detail', async () => {
    const service = await createService();
    const provider = bodyOf<Provider>(await createProvider(service.id));

    for (const name of ['Base', 'Premium']) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: auth,
        payload: { serviceProviderId: provider.id, name, price: '299.00' },
      });
    }

    const read = bodyOf<Service>(await app.inject({
      method: 'GET',
      url: `/api/v1/services/${service.id}`,
      headers: auth,
    }));

    expect(read.providers.find(p => p.id === provider.id)?.packageCount).toBe(2);
  });

  it('lets two providers of one service exist, and keeps one default', async () => {
    const service = await createService();
    const first = bodyOf<Provider>(await createProvider(service.id, { isDefault: true }));
    const second = bodyOf<Provider>(await createProvider(service.id, { name: 'Hathway', slug: `hathway-${unique()}`, isDefault: true }));

    const providers = bodyOf<Provider[]>(await app.inject({
      method: 'GET',
      url: `/api/v1/service-providers?serviceId=${service.id}`,
      headers: auth,
    }));

    expect(providers.filter(p => p.isDefault).map(p => p.id)).toEqual([second.id]);
    expect(providers.find(p => p.id === first.id)?.isDefault).toBe(false);
  });

  it('refuses a second provider with the same slug under one service', async () => {
    const service = await createService();
    const slug = `act-${unique()}`;

    await createProvider(service.id, { slug });
    const clash = await createProvider(service.id, { slug });

    expect(clash.statusCode).toBe(409);
    expect(bodyOf(clash).code).toBe('RESOURCE_CONFLICT');
  });

  it('allows the same provider slug under a different service', async () => {
    const slug = `airtel-${unique()}`;
    const broadband = await createService({ slug: `broadband-${unique()}`, icon: 'wifi', name: 'Broadband' });
    const iptv = await createService({ slug: `iptv-${unique()}`, icon: 'satellite', name: 'IPTV' });

    expect((await createProvider(broadband.id, { name: 'Airtel', slug })).statusCode).toBe(201);
    expect((await createProvider(iptv.id, { name: 'Airtel', slug })).statusCode).toBe(201);
  });

  it('will not retire a service while a provider still delivers it', async () => {
    const service = await createService();
    const provider = bodyOf<Provider>(await createProvider(service.id));

    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/services/${service.id}`, headers: auth });
    expect(blocked.statusCode).toBe(409);
    expect(bodyOf(blocked).code).toBe('RESOURCE_IN_USE');

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/service-providers/${provider.id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/services/${service.id}`, headers: auth })).statusCode).toBe(204);

    const gone = await app.inject({ method: 'GET', url: `/api/v1/services/${service.id}`, headers: auth });
    expect(gone.statusCode).toBe(404);
  });

  it('refuses the catalogue to a role that does not hold the key', async () => {
    const service = await createService();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/services/${service.id}`,
      headers: { ...auth, 'x-tenant-id': data.tenantB.id },
    });

    expect(response.statusCode).toBe(403);
    expect(bodyOf(response).code).toBe('PERM_DENIED');
  });

  it('derives a slug from the name when the form does not send one', async () => {
    const name = `Tata Play ${unique()}`;
    const service = await createService({ name, slug: undefined });
    expect(service.slug).toBe(name.toLowerCase().replace(/ /g, '-'));

    const first = await createProvider(service.id, { name: 'ACT Digital', slug: undefined });
    const second = await createProvider(service.id, { name: 'ACT Digital', slug: undefined });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(bodyOf<Provider>(first).slug).toBe('act-digital');
    expect(bodyOf<Provider>(second).slug).toBe('act-digital-2');
  });
});

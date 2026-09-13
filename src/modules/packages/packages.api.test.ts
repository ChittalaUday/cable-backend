import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { channels } from '@/db/schema';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

/**
 * Packages end to end (docs/services-providers-packages.md).
 *
 * The rules that matter: a package belongs to a supplier, a lineup may only
 * hold that supplier's channels, and money survives the round trip as a string.
 */

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let auth: Record<string, string>;
let providerA: string;
let providerB: string;

interface Pkg { id: string; name: string; price: string; serviceProviderId: string; channelCount: number; channels?: { id: string }[] }

const unique = () => randomUUID().slice(0, 8);

async function post<T>(url: string, payload: Record<string, unknown>): Promise<T> {
  const response = await app.inject({ method: 'POST', url, headers: auth, payload });
  expect(response.statusCode).toBe(201);
  return bodyOf<T>(response);
}

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

  const service = await post<{ id: string }>('/api/v1/services', {
    name: 'Cable TV',
    slug: `cable-${unique()}`,
    serviceType: 'cable',
  });

  // Two MSOs of one service: the case the whole redesign exists for.
  providerA = (await post<{ id: string }>('/api/v1/service-providers', {
    serviceId: service.id,
    name: 'ACT Digital',
    slug: `act-${unique()}`,
  })).id;

  providerB = (await post<{ id: string }>('/api/v1/service-providers', {
    serviceId: service.id,
    name: 'Hathway',
    slug: `hathway-${unique()}`,
  })).id;
});

afterAll(async () => {
  await app.close();
  await data.cleanup();
  await close();
});

async function seedChannel(serviceProviderId: string, channelNumber: number) {
  const [row] = await db.insert(channels).values({
    tenantId: data.tenantA.id,
    serviceProviderId,
    channelNumber,
    name: `Channel ${channelNumber}`,
    slug: `channel-${channelNumber}-${unique()}`,
  }).returning();

  return row!.id;
}

describe('packages', () => {
  it('hangs off the provider, and reports whose it is', async () => {
    const pkg = await post<Pkg>('/api/v1/packages', {
      serviceProviderId: providerA,
      name: 'ACT Base 250',
      slug: `act-base-${unique()}`,
      price: '349.00',
      msoShare: '164.01',
    });

    expect(pkg.serviceProviderId).toBe(providerA);
    // Money crosses the wire as a string and comes back unrounded (§8).
    expect(pkg.price).toBe('349.00');
  });

  it('lets both providers use the same package slug', async () => {
    const slug = `base-${unique()}`;

    await post('/api/v1/packages', { serviceProviderId: providerA, name: 'Base', slug });
    await post('/api/v1/packages', { serviceProviderId: providerB, name: 'Base', slug });
  });

  it('refuses a duplicate slug under one provider', async () => {
    const slug = `dup-${unique()}`;
    await post('/api/v1/packages', { serviceProviderId: providerA, name: 'Base', slug });

    const clash = await app.inject({
      method: 'POST',
      url: '/api/v1/packages',
      headers: auth,
      payload: { serviceProviderId: providerA, name: 'Base again', slug },
    });

    expect(clash.statusCode).toBe(409);
  });

  it('replaces a lineup, and refuses another provider’s channels', async () => {
    const pkg = await post<Pkg>('/api/v1/packages', {
      serviceProviderId: providerA,
      name: 'Bouquet',
      slug: `bouquet-${unique()}`,
      packageType: 'bouquet',
    });

    const mine = [await seedChannel(providerA, 101), await seedChannel(providerA, 102)];
    const theirs = await seedChannel(providerB, 101);

    const set = await app.inject({
      method: 'PUT',
      url: `/api/v1/packages/${pkg.id}/channels`,
      headers: auth,
      payload: { channels: mine.map(channelId => ({ channelId })) },
    });

    expect(set.statusCode).toBe(200);
    expect(bodyOf<Pkg>(set).channelCount).toBe(2);

    const crossed = await app.inject({
      method: 'PUT',
      url: `/api/v1/packages/${pkg.id}/channels`,
      headers: auth,
      payload: { channels: [{ channelId: theirs }] },
    });

    expect(crossed.statusCode).toBe(400);
    expect(bodyOf(crossed).code).toBe('VALIDATION_FAILED');

    // The failed call changed nothing.
    const read = bodyOf<Pkg>(await app.inject({ method: 'GET', url: `/api/v1/packages/${pkg.id}`, headers: auth }));
    expect(read.channels?.length).toBe(2);
  });

  it('filters by service, joining through the provider', async () => {
    const otherService = await post<{ id: string }>('/api/v1/services', {
      name: 'Broadband',
      slug: `broadband-${unique()}`,
      serviceType: 'broadband',
    });
    const isp = await post<{ id: string }>('/api/v1/service-providers', {
      serviceId: otherService.id,
      name: 'Satya Fiber',
      slug: `fiber-${unique()}`,
    });
    await post('/api/v1/packages', { serviceProviderId: isp.id, name: '100 Mbps', slug: `mbps-${unique()}` });

    const listed = bodyOf<{ items: Pkg[]; total: number }>(await app.inject({
      method: 'GET',
      url: `/api/v1/packages?serviceId=${otherService.id}`,
      headers: auth,
    }));

    expect(listed.total).toBe(1);
    expect(listed.items[0]?.serviceProviderId).toBe(isp.id);
  });

  it('rejects a price that is not a decimal string', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/packages',
      headers: auth,
      payload: { serviceProviderId: providerA, name: 'Bad', slug: `bad-${unique()}`, price: 349.005 },
    });

    expect(response.statusCode).toBe(400);
    expect(bodyOf(response).code).toBe('VALIDATION_FAILED');
  });
});

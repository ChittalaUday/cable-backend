import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { LocationsService } from '@/modules/locations/location.service';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId } from '@/test/fixtures';
import { bodyOf } from '@/test/http';
import { CoverageService } from './coverage.service';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let auth: Record<string, string>;

let area: string;
let building: string;
let blockA: string;
let flat: string;
let blockC: string;
let otherTown: string;

let cableService: string;
let act: string;
let hathway: string;
let actPackage: string;

const unique = () => randomUUID().slice(0, 8);

interface Availability {
  services: { id: string; name: string; providers: { id: string; name: string; packages: { id: string }[] }[] }[];
}

async function post<T>(url: string, payload: Record<string, unknown>): Promise<T> {
  const response = await app.inject({ method: 'POST', url, headers: auth, payload });
  expect(response.statusCode).toBe(201);
  return bodyOf<T>(response);
}

async function node(name: string, parentId: string | null, schemaId?: string): Promise<string> {
  const payload: Record<string, unknown> = parentId === null ? { schemaId, name } : { parentId, name };
  return (await post<{ id: string }>('/api/v1/locations', payload)).id;
}

async function setCoverage(url: string, entries: Record<string, unknown>[]) {
  return app.inject({ method: 'PUT', url, headers: auth, payload: { entries } });
}

async function availableAt(locationId: string): Promise<Availability> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/locations/${locationId}/availability`,
    headers: auth,
  });

  expect(response.statusCode).toBe(200);
  return bodyOf<Availability>(response);
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

  const categories: Record<string, string> = {};
  for (const name of ['Area', 'Building', 'Block', 'Door']) {
    categories[name] = (await post<{ id: string }>('/api/v1/location-categories', {
      name,
      slug: `${name.toLowerCase()}-${unique()}`,
    })).id;
  }

  const schema = await post<{ id: string }>('/api/v1/location-schemas', {
    name: 'Apartment',
    slug: `apartment-${unique()}`,
    levels: ['Area', 'Building', 'Block', 'Door'].map(n => ({ categoryId: categories[n]! })),
  });

  area = await node(`Mandapeta ${unique()}`, null, schema.id);
  building = await node('Sri Sai Apartments', area);
  blockA = await node('Block A', building);
  blockC = await node('Block C', building);
  flat = await node('A101', blockA);
  otherTown = await node(`Ravulapalem ${unique()}`, null, schema.id);

  cableService = (await post<{ id: string }>('/api/v1/services', {
    name: 'Cable TV',
    slug: `cable-${unique()}`,
    icon: 'tv',
  })).id;

  act = (await post<{ id: string }>('/api/v1/service-providers', {
    serviceId: cableService,
    name: 'ACT Digital',
    slug: `act-${unique()}`,
    isDefault: true,
  })).id;

  hathway = (await post<{ id: string }>('/api/v1/service-providers', {
    serviceId: cableService,
    name: 'Hathway',
    slug: `hathway-${unique()}`,
  })).id;

  actPackage = (await post<{ id: string }>('/api/v1/packages', {
    serviceProviderId: act,
    name: 'ACT Base 250',
    slug: `act-base-${unique()}`,
    price: '349.00',
  })).id;
});

afterAll(async () => {
  await app.close();
  await data.cleanup();
  await close();
});

describe('coverage', () => {
  it('sells everywhere while nothing is configured', async () => {
    const available = await availableAt(flat);
    const service = available.services.find(s => s.id === cableService);

    expect(service?.providers.map(p => p.id).sort()).toEqual([act, hathway].sort());
  });

  it('covers everything below the node it names', async () => {
    expect((await setCoverage(`/api/v1/service-providers/${act}/coverage`, [{ locationId: area }])).statusCode).toBe(200);
    expect((await setCoverage(`/api/v1/service-providers/${hathway}/coverage`, [{ locationId: building }])).statusCode).toBe(200);

    const atFlat = await availableAt(flat);
    const providers = atFlat.services.find(s => s.id === cableService)?.providers ?? [];

    expect(providers.map(p => p.id).sort()).toEqual([act, hathway].sort());
    expect(providers.find(p => p.id === act)?.packages.map(p => p.id)).toEqual([actPackage]);
  });

  it('lets a deeper row punch a hole in a covered area', async () => {
    await setCoverage(`/api/v1/service-providers/${act}/coverage`, [
      { locationId: area },
      { locationId: blockC, isAvailable: false, note: 'fibre not pulled past Block C' },
    ]);

    const inBlockA = await availableAt(blockA);
    const inBlockC = await availableAt(blockC);

    expect(inBlockA.services.find(s => s.id === cableService)?.providers.map(p => p.id)).toContain(act);
    expect(inBlockC.services.find(s => s.id === cableService)?.providers.map(p => p.id)).not.toContain(act);
  });

  it('reads back as breadcrumbs, not bare ids', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/service-providers/${act}/coverage`,
      headers: auth,
    });

    const rows = bodyOf<{ locationPath: string; isAvailable: boolean }[]>(response);
    expect(rows.some(r => r.locationPath.includes('Block C') && !r.isAvailable)).toBe(true);
  });

  it('refuses coverage pointed at another tenant’s location', async () => {
    const response = await setCoverage(`/api/v1/service-providers/${act}/coverage`, [
      { locationId: randomUUID() },
    ]);

    expect(response.statusCode).toBe(404);
    expect(bodyOf(response).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('falls back to the service-wide row when the provider has none', async () => {
    await setCoverage(`/api/v1/services/${cableService}/coverage`, [
      { locationId: area },
      { locationId: blockC, isAvailable: false },
    ]);
    await setCoverage(`/api/v1/service-providers/${hathway}/coverage`, []);

    const inBlockC = await availableAt(blockC);
    expect(inBlockC.services.find(s => s.id === cableService)?.providers.map(p => p.id) ?? []).not.toContain(hathway);

    const inBlockA = await availableAt(blockA);
    expect(inBlockA.services.find(s => s.id === cableService)?.providers.map(p => p.id) ?? []).toContain(hathway);
  });

  it('answers the question a subscription has to ask before it is written', async () => {
    const coverage = new CoverageService(db, new LocationsService(db));
    const access = { tenantId: data.tenantA.id, userId: data.active.id } as Parameters<typeof coverage.availabilityAt>[0];

    await setCoverage(`/api/v1/service-providers/${act}/coverage`, [
      { locationId: area },
      { locationId: blockC, isAvailable: false },
    ]);

    expect(await coverage.isPackageAvailableAt(access, { packageId: actPackage, locationId: flat })).toBe(true);
    expect(await coverage.isPackageAvailableAt(access, { packageId: actPackage, locationId: blockC })).toBe(false);

    expect(await coverage.isPackageAvailableAt(access, { packageId: randomUUID(), locationId: flat })).toBe(false);
  });

  it('lets one package opt out of a place its provider still serves', async () => {
    const premium = (await post<{ id: string }>('/api/v1/packages', {
      serviceProviderId: act,
      name: 'ACT Premium 4K',
      slug: `act-premium-${unique()}`,
      price: '899.00',
    })).id;

    await setCoverage(`/api/v1/services/${cableService}/coverage`, [{ locationId: area }]);
    await setCoverage(`/api/v1/service-providers/${act}/coverage`, [{ locationId: area }]);
    const written = await setCoverage(`/api/v1/packages/${premium}/coverage`, [
      { locationId: blockC, isAvailable: false },
    ]);
    expect(written.statusCode).toBe(200);
    expect(bodyOf<{ packageId: string }[]>(written)[0]?.packageId).toBe(premium);

    const inBlockC = await availableAt(blockC);
    const actInBlockC = inBlockC.services
      .find(s => s.id === cableService)
      ?.providers
      .find(p => p.id === act);

    expect(actInBlockC).toBeDefined();
    expect(actInBlockC?.packages.map(pkg => pkg.id)).toContain(actPackage);
    expect(actInBlockC?.packages.map(pkg => pkg.id)).not.toContain(premium);

    const inFlat = await availableAt(flat);
    const actInFlat = inFlat.services
      .find(s => s.id === cableService)
      ?.providers
      .find(p => p.id === act);
    expect(actInFlat?.packages.map(pkg => pkg.id)).toContain(premium);

    const coverage = new CoverageService(db, new LocationsService(db));
    const access = { tenantId: data.tenantA.id, userId: data.active.id } as Parameters<typeof coverage.availabilityAt>[0];
    expect(await coverage.isPackageAvailableAt(access, { packageId: premium, locationId: blockC })).toBe(false);
    expect(await coverage.isPackageAvailableAt(access, { packageId: premium, locationId: flat })).toBe(true);

    await setCoverage(`/api/v1/packages/${premium}/coverage`, []);
    expect(await coverage.isPackageAvailableAt(access, { packageId: premium, locationId: blockC })).toBe(true);
  });

  it('keeps the three levels separate when one of them is rewritten', async () => {
    const tier = (await post<{ id: string }>('/api/v1/packages', {
      serviceProviderId: act,
      name: 'ACT Sports',
      slug: `act-sports-${unique()}`,
      price: '499.00',
    })).id;

    await setCoverage(`/api/v1/packages/${tier}/coverage`, [{ locationId: blockC, isAvailable: false }]);
    await setCoverage(`/api/v1/service-providers/${act}/coverage`, [{ locationId: area }]);

    const still = await app.inject({
      method: 'GET',
      url: `/api/v1/packages/${tier}/coverage`,
      headers: auth,
    });

    expect(bodyOf<unknown[]>(still)).toHaveLength(1);

    const providerRows = await app.inject({
      method: 'GET',
      url: `/api/v1/service-providers/${act}/coverage`,
      headers: auth,
    });

    expect(bodyOf<{ packageId: string | null }[]>(providerRows).every(row => row.packageId === null)).toBe(true);
  });
  it('sells only where it says, once it has said anywhere', async () => {
    await setCoverage(`/api/v1/services/${cableService}/coverage`, []);
    await setCoverage(`/api/v1/service-providers/${act}/coverage`, [{ locationId: area }]);

    const here = await availableAt(flat);
    const there = await availableAt(otherTown);

    expect(here.services.find(s => s.id === cableService)?.providers.map(p => p.id)).toContain(act);
    expect(there.services.find(s => s.id === cableService)?.providers.map(p => p.id) ?? []).not.toContain(act);
  });

  it('treats a list of only carve-outs as "everywhere except"', async () => {
    await setCoverage(`/api/v1/services/${cableService}/coverage`, []);
    await setCoverage(`/api/v1/service-providers/${hathway}/coverage`, [
      { locationId: blockC, isAvailable: false },
    ]);

    const there = await availableAt(otherTown);
    const inBlockC = await availableAt(blockC);

    expect(there.services.find(s => s.id === cableService)?.providers.map(p => p.id)).toContain(hathway);
    expect(inBlockC.services.find(s => s.id === cableService)?.providers.map(p => p.id) ?? []).not.toContain(hathway);
  });

  describe('a parent bounds its children', () => {
    it('takes every provider down with the service', async () => {
      await setCoverage(`/api/v1/services/${cableService}/coverage`, [
        { locationId: area },
        { locationId: blockC, isAvailable: false },
      ]);
      await setCoverage(`/api/v1/service-providers/${act}/coverage`, [{ locationId: area }]);

      const inBlockC = await availableAt(blockC);
      expect(inBlockC.services.find(s => s.id === cableService)?.providers.map(p => p.id) ?? [])
        .not
        .toContain(act);

      const coverage = new CoverageService(db, new LocationsService(db));
      const access = { tenantId: data.tenantA.id, userId: data.active.id } as Parameters<typeof coverage.availabilityAt>[0];
      expect(await coverage.isPackageAvailableAt(access, { packageId: actPackage, locationId: blockC })).toBe(false);
      expect(await coverage.isPackageAvailableAt(access, { packageId: actPackage, locationId: flat })).toBe(true);
    });

    it('refuses a provider pointed outside its service', async () => {
      await setCoverage(`/api/v1/services/${cableService}/coverage`, [
        { locationId: area },
        { locationId: blockC, isAvailable: false },
      ]);

      const response = await setCoverage(`/api/v1/service-providers/${act}/coverage`, [
        { locationId: area },
        { locationId: blockC },
      ]);

      expect(response.statusCode).toBe(400);
      expect(bodyOf(response).message).toContain('Block C');

      const rows = await app.inject({
        method: 'GET',
        url: `/api/v1/service-providers/${act}/coverage`,
        headers: auth,
      });
      expect(bodyOf<{ locationPath: string }[]>(rows).some(r => r.locationPath.includes('Block C'))).toBe(false);
    });

    it('still takes a carve-out at a place the parent does not serve', async () => {
      const response = await setCoverage(`/api/v1/service-providers/${hathway}/coverage`, [
        { locationId: blockC, isAvailable: false },
      ]);

      expect(response.statusCode).toBe(200);
    });

    it('refuses a package pointed outside its provider', async () => {
      await setCoverage(`/api/v1/services/${cableService}/coverage`, [{ locationId: area }]);
      await setCoverage(`/api/v1/service-providers/${act}/coverage`, [
        { locationId: area },
        { locationId: blockC, isAvailable: false },
      ]);

      const response = await setCoverage(`/api/v1/packages/${actPackage}/coverage`, [
        { locationId: blockC },
      ]);

      expect(response.statusCode).toBe(400);
      expect(bodyOf(response).message).toContain('provider');
    });
  });

  it('tells two same-named packages for two areas apart', async () => {
    await setCoverage(`/api/v1/services/${cableService}/coverage`, []);
    await setCoverage(`/api/v1/service-providers/${act}/coverage`, []);

    const name = `Gold Tier ${unique()}`;
    const oldTown = (await post<{ id: string }>('/api/v1/packages', {
      serviceProviderId: act,
      name,
      price: '499.00',
    })).id;
    const newBlocks = (await post<{ id: string }>('/api/v1/packages', {
      serviceProviderId: act,
      name,
      price: '649.00',
    })).id;

    await setCoverage(`/api/v1/packages/${oldTown}/coverage`, [{ locationId: blockA }]);
    await setCoverage(`/api/v1/packages/${newBlocks}/coverage`, [{ locationId: blockC }]);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/packages?serviceProviderId=${act}`,
      headers: auth,
    });

    const both = bodyOf<{ items: { id: string; coverageAreas: string[] }[] }>(listed).items.filter(item => item.id === oldTown || item.id === newBlocks);

    expect(both).toHaveLength(2);
    expect(both.find(p => p.id === oldTown)?.coverageAreas.join()).toContain('Block A');
    expect(both.find(p => p.id === newBlocks)?.coverageAreas.join()).toContain('Block C');

    const inBlockA = await availableAt(blockA);
    const sold = inBlockA.services.find(s => s.id === cableService)
      ?.providers
      .find(p => p.id === act)
      ?.packages
      .map(p => p.id) ?? [];

    expect(sold).toContain(oldTown);
    expect(sold).not.toContain(newBlocks);
  });

  describe('the location list narrowed to what a level may sell', () => {
    async function names(params: string): Promise<string[]> {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/locations?parentId=${building}&${params}`,
        headers: auth,
      });

      expect(response.statusCode).toBe(200);
      return bodyOf<{ items: { name: string }[] }>(response).items.map(item => item.name);
    }

    it('drops the blocks the service has switched off', async () => {
      await setCoverage(`/api/v1/services/${cableService}/coverage`, [
        { locationId: area },
        { locationId: blockC, isAvailable: false },
      ]);
      await setCoverage(`/api/v1/service-providers/${act}/coverage`, []);

      expect(await names('')).toEqual(expect.arrayContaining(['Block A', 'Block C']));
      expect(await names(`coverageServiceId=${cableService}`)).toEqual(['Block A']);
    });

    it('narrows again for a provider, without losing what the service excluded', async () => {
      await setCoverage(`/api/v1/services/${cableService}/coverage`, [
        { locationId: area },
        { locationId: blockC, isAvailable: false },
      ]);
      await setCoverage(`/api/v1/service-providers/${act}/coverage`, [{ locationId: blockA }]);

      expect(await names(`coverageServiceId=${cableService}&coverageProviderId=${act}`)).toEqual(['Block A']);
    });

    it('offers everything while nothing is configured', async () => {
      await setCoverage(`/api/v1/services/${cableService}/coverage`, []);
      await setCoverage(`/api/v1/service-providers/${act}/coverage`, []);

      expect(await names(`coverageServiceId=${cableService}&coverageProviderId=${act}`))
        .toEqual(expect.arrayContaining(['Block A', 'Block C']));
    });
  });
});

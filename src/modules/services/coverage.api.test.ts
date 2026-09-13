import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { LocationsService } from '@/modules/locations/locations.service';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId } from '@/test/fixtures';
import { bodyOf } from '@/test/http';
import { CoverageService } from './coverage.service';

/**
 * Coverage and availability end to end
 * (docs/services-providers-packages.md §5).
 *
 * The rule under test is the one the whole design turns on: a row covers its
 * node and everything below it, and the nearest ancestor wins — so a hole can
 * be punched in a covered town without enumerating the streets around it.
 */

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let auth: Record<string, string>;

/** Mandapeta → Sri Sai Apartments → Block A → A101, and Block C beside it. */
let area: string;
let building: string;
let blockA: string;
let flat: string;
let blockC: string;

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

  // A location tree to sell into.
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

  cableService = (await post<{ id: string }>('/api/v1/services', {
    name: 'Cable TV',
    slug: `cable-${unique()}`,
    serviceType: 'cable',
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

    // No coverage rows yet: an operator who has configured nothing still sells.
    expect(service?.providers.map(p => p.id).sort()).toEqual([act, hathway].sort());
  });

  it('covers everything below the node it names', async () => {
    // ACT serves the town; Hathway serves nothing but the one building.
    expect((await setCoverage(`/api/v1/service-providers/${act}/coverage`, [{ locationId: area }])).statusCode).toBe(200);
    expect((await setCoverage(`/api/v1/service-providers/${hathway}/coverage`, [{ locationId: building }])).statusCode).toBe(200);

    const atFlat = await availableAt(flat);
    const providers = atFlat.services.find(s => s.id === cableService)?.providers ?? [];

    // Four levels below the row ACT was given, and it still reaches.
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
    // Nearest ancestor wins: Block C's own row beats the town-wide one.
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
    // Hathway keeps its building row; the service says "not in Block C at all".
    await setCoverage(`/api/v1/services/${cableService}/coverage`, [
      { locationId: area },
      { locationId: blockC, isAvailable: false },
    ]);
    await setCoverage(`/api/v1/service-providers/${hathway}/coverage`, []);

    const inBlockC = await availableAt(blockC);
    // With ACT excluded by its own row and Hathway by the service-wide one,
    // the service drops out of the response entirely — there is nothing to sell
    // here, which is exactly what the wizard should show.
    expect(inBlockC.services.find(s => s.id === cableService)?.providers.map(p => p.id) ?? []).not.toContain(hathway);

    const inBlockA = await availableAt(blockA);
    expect(inBlockA.services.find(s => s.id === cableService)?.providers.map(p => p.id) ?? []).toContain(hathway);
  });

  it('answers the question a subscription has to ask before it is written', async () => {
    // The enforcement primitive for `POST /subscriptions` (§6 of the doc):
    // a package is only sellable where its provider reaches. Called directly,
    // because the subscriptions module that will use it does not exist yet.
    const coverage = new CoverageService(db, new LocationsService(db));
    const access = { tenantId: data.tenantA.id, userId: data.active.id } as Parameters<typeof coverage.availabilityAt>[0];

    await setCoverage(`/api/v1/service-providers/${act}/coverage`, [
      { locationId: area },
      { locationId: blockC, isAvailable: false },
    ]);

    expect(await coverage.isPackageAvailableAt(access, { packageId: actPackage, locationId: flat })).toBe(true);
    expect(await coverage.isPackageAvailableAt(access, { packageId: actPackage, locationId: blockC })).toBe(false);

    // A package id that is not this tenant's is not "available" either.
    expect(await coverage.isPackageAvailableAt(access, { packageId: randomUUID(), locationId: flat })).toBe(false);
  });
});

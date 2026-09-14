import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { channels, tenantMemberships, users } from '@/db/schema';
import { hashPassword } from '@/shared/security/password';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

/**
 * End-to-end API testing of the complete catalogue hierarchy:
 * Services (1-to-many) -> Service Providers (1-to-many) -> Packages (with or without Channels).
 *
 * All operations are performed exclusively through HTTP API endpoints.
 */

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let adminAuthA: Record<string, string>;
let tenantBAdminAuth: Record<string, string>;
let customerAuthA: Record<string, string>;

interface ServiceDto {
  id: string;
  name: string;
  slug: string;
  serviceIcon: string | null;
  providerCount: number;
  status: string;
}

interface ProviderDto {
  id: string;
  serviceId: string;
  name: string;
  slug: string;
  code?: string;
  isDefault: boolean;
  status: string;
}

interface PackageDto {
  id: string;
  serviceProviderId: string;
  serviceProviderName?: string;
  serviceId?: string;
  serviceName?: string;
  name: string;
  slug: string;
  packageType: string;
  price: string;
  discount: string;
  msoShare: string;
  taxRate: string;
  billingCycle: string;
  status: string;
  channelCount: number;
}

interface PackageDetailDto extends PackageDto {
  channels: {
    id: string;
    channelNumber: number;
    name: string;
    slug: string;
    genre: string | null;
    isMandatory: boolean;
  }[];
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

const unique = () => randomUUID().slice(0, 8);

async function loginUser(email: string, password = TEST_PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: email, password },
  });
  expect(response.statusCode).toBe(200);
  return bodyOf<{ accessToken: string }>(response).accessToken;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  // 1. Admin A
  const tokenA = await loginUser(data.active.email);
  adminAuthA = {
    'authorization': `Bearer ${tokenA}`,
    'x-tenant-id': data.tenantA.id,
  };

  // 2. Tenant B Admin
  const [adminBUser] = await db
    .insert(users)
    .values({
      email: uniqueEmail('admin-b'),
      name: 'Tenant B Admin',
      passwordHash: await hashPassword(TEST_PASSWORD),
    })
    .returning();
  await db.insert(tenantMemberships).values({
    userId: adminBUser!.id,
    tenantId: data.tenantB.id,
    roleId: SYSTEM_ROLES.ADMIN,
  });
  const tokenB = await loginUser(adminBUser!.email!);
  tenantBAdminAuth = {
    'authorization': `Bearer ${tokenB}`,
    'x-tenant-id': data.tenantB.id,
  };

  // 3. Customer A (Customer role in Tenant B)
  customerAuthA = {
    'authorization': `Bearer ${tokenA}`,
    'x-tenant-id': data.tenantB.id, // data.active is 'customer' role in tenantB (§4.1)
  };
});

afterAll(async () => {
  await app.close();
  await data.cleanup();
  await close();
});

// Helper for channels seeded for tests
async function seedProviderChannel(serviceProviderId: string, channelNumber: number, name: string) {
  const [row] = await db.insert(channels).values({
    tenantId: data.tenantA.id,
    serviceProviderId,
    channelNumber,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${unique()}`,
  }).returning();

  return row!.id;
}

describe('service -> provider -> package -> channel hierarchy API tests', () => {
  // Shared state across the hierarchy
  let cableService: ServiceDto;
  let broadbandService: ServiceDto;

  let provider1A: ProviderDto; // ACT Digital
  let provider1B: ProviderDto; // Hathway Digital
  let provider1C: ProviderDto; // Den Networks

  let provider2A: ProviderDto; // Satya Fiber
  let provider2B: ProviderDto; // Airtel Broadband

  let pkg1A_withChannels: PackageDto;
  let pkg1A_noChannels: PackageDto;
  let pkg1B_withChannels: PackageDto;
  let pkg1B_noChannels: PackageDto;
  let pkg2A_noChannels: PackageDto;

  let ch1A_1: string;
  let ch1A_2: string;
  let ch1A_3: string;
  let ch1B_1: string;
  let ch1B_2: string;

  describe('1. Services and Providers Creation & Multi-Provider Hierarchy', () => {
    it('creates multiple services under the tenant', async () => {
      // Service 1: Cable TV
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/services',
        headers: adminAuthA,
        payload: {
          name: 'Cable Television',
          slug: `cable-${unique()}`,
          icon: 'tv',
          description: 'Linear digital TV feeds',
        },
      });
      expect(res1.statusCode).toBe(201);
      cableService = bodyOf<ServiceDto>(res1);
      expect(cableService.providerCount).toBe(0);

      // Service 2: Broadband
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/services',
        headers: adminAuthA,
        payload: {
          name: 'High-Speed Broadband',
          slug: `broadband-${unique()}`,
          icon: 'wifi',
          description: 'FTTH fiber internet',
        },
      });
      expect(res2.statusCode).toBe(201);
      broadbandService = bodyOf<ServiceDto>(res2);
      expect(broadbandService.providerCount).toBe(0);
    });

    it('adds multiple providers to each service and maintains single default per service', async () => {
      // Service 1 Provider 1A: ACT Digital (default)
      const res1A = await app.inject({
        method: 'POST',
        url: '/api/v1/service-providers',
        headers: adminAuthA,
        payload: {
          serviceId: cableService.id,
          name: 'ACT Digital MSO',
          slug: `act-mso-${unique()}`,
          code: 'ACT-01',
          isDefault: true,
        },
      });
      expect(res1A.statusCode).toBe(201);
      provider1A = bodyOf<ProviderDto>(res1A);
      expect(provider1A.isDefault).toBe(true);

      // Service 1 Provider 1B: Hathway Digital (not default initially)
      const res1B = await app.inject({
        method: 'POST',
        url: '/api/v1/service-providers',
        headers: adminAuthA,
        payload: {
          serviceId: cableService.id,
          name: 'Hathway Digital MSO',
          slug: `hathway-mso-${unique()}`,
          code: 'HW-02',
          isDefault: false,
        },
      });
      expect(res1B.statusCode).toBe(201);
      provider1B = bodyOf<ProviderDto>(res1B);
      expect(provider1B.isDefault).toBe(false);

      // Service 1 Provider 1C: Den Networks
      const res1C = await app.inject({
        method: 'POST',
        url: '/api/v1/service-providers',
        headers: adminAuthA,
        payload: {
          serviceId: cableService.id,
          name: 'Den Networks MSO',
          slug: `den-mso-${unique()}`,
          isDefault: false,
        },
      });
      expect(res1C.statusCode).toBe(201);
      provider1C = bodyOf<ProviderDto>(res1C);

      // Service 2 Provider 2A: Satya Fiber
      const res2A = await app.inject({
        method: 'POST',
        url: '/api/v1/service-providers',
        headers: adminAuthA,
        payload: {
          serviceId: broadbandService.id,
          name: 'Satya Fiber ISP',
          slug: `satya-fiber-${unique()}`,
          isDefault: true,
        },
      });
      expect(res2A.statusCode).toBe(201);
      provider2A = bodyOf<ProviderDto>(res2A);

      // Service 2 Provider 2B: Airtel Broadband
      const res2B = await app.inject({
        method: 'POST',
        url: '/api/v1/service-providers',
        headers: adminAuthA,
        payload: {
          serviceId: broadbandService.id,
          name: 'Airtel Broadband ISP',
          slug: `airtel-isp-${unique()}`,
          isDefault: false,
        },
      });
      expect(res2B.statusCode).toBe(201);
      provider2B = bodyOf<ProviderDto>(res2B);
    });

    it('correctly aggregates providerCount on services and lists providers filtered by serviceId', async () => {
      // Cable service should report 3 providers
      const readCable = bodyOf<ServiceDto>(await app.inject({
        method: 'GET',
        url: `/api/v1/services/${cableService.id}`,
        headers: adminAuthA,
      }));
      expect(readCable.providerCount).toBe(3);

      // Broadband service should report 2 providers
      const readBroadband = bodyOf<ServiceDto>(await app.inject({
        method: 'GET',
        url: `/api/v1/services/${broadbandService.id}`,
        headers: adminAuthA,
      }));
      expect(readBroadband.providerCount).toBe(2);

      // List providers for Cable service
      const cableProvidersRes = await app.inject({
        method: 'GET',
        url: `/api/v1/service-providers?serviceId=${cableService.id}`,
        headers: adminAuthA,
      });
      expect(cableProvidersRes.statusCode).toBe(200);
      const cableProviders = bodyOf<ProviderDto[]>(cableProvidersRes);
      expect(cableProviders.length).toBe(3);
      expect(cableProviders.map(p => p.id)).toEqual(
        expect.arrayContaining([provider1A.id, provider1B.id, provider1C.id]),
      );
    });

    it('switches the default provider when isDefault is set on another provider for the same service', async () => {
      // Patch Hathway (provider1B) to be isDefault: true
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/service-providers/${provider1B.id}`,
        headers: adminAuthA,
        payload: { isDefault: true },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(bodyOf<ProviderDto>(patchRes).isDefault).toBe(true);

      // Verify ACT (provider1A) is no longer default
      const read1A = bodyOf<ProviderDto>(await app.inject({
        method: 'GET',
        url: `/api/v1/service-providers/${provider1A.id}`,
        headers: adminAuthA,
      }));
      expect(read1A.isDefault).toBe(false);

      // Switch back ACT as default for consistency in downstream tests
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/service-providers/${provider1A.id}`,
        headers: adminAuthA,
        payload: { isDefault: true },
      });
    });

    it('enforces slug uniqueness per service but allows the same provider slug under a different service', async () => {
      const sharedSlug = `national-${unique()}`;

      // Create provider under Cable with sharedSlug -> 201
      const pCable = await app.inject({
        method: 'POST',
        url: '/api/v1/service-providers',
        headers: adminAuthA,
        payload: { serviceId: cableService.id, name: 'National Network', slug: sharedSlug },
      });
      expect(pCable.statusCode).toBe(201);

      // Create duplicate provider under Cable with same sharedSlug -> 409
      const pCableClash = await app.inject({
        method: 'POST',
        url: '/api/v1/service-providers',
        headers: adminAuthA,
        payload: { serviceId: cableService.id, name: 'National Network 2', slug: sharedSlug },
      });
      expect(pCableClash.statusCode).toBe(409);

      // Create provider under Broadband with same sharedSlug -> 201 allowed
      const pBroadband = await app.inject({
        method: 'POST',
        url: '/api/v1/service-providers',
        headers: adminAuthA,
        payload: { serviceId: broadbandService.id, name: 'National Fiber', slug: sharedSlug },
      });
      expect(pBroadband.statusCode).toBe(201);
    });
  });

  describe('2. Packages Creation (Multiple Packages per Provider)', () => {
    it('creates multiple packages under Provider 1A, Provider 1B, and Provider 2A', async () => {
      // Provider 1A Package 1: ACT Starter Bouquet (will have channels)
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1A.id,
          name: 'ACT Starter Bouquet',
          slug: `act-starter-${unique()}`,
          packageType: 'bouquet',
          price: '249.00',
          discount: '0.00',
          msoShare: '120.00',
          taxRate: '18.00',
          billingCycle: 'monthly',
        },
      });
      expect(res1.statusCode).toBe(201);
      pkg1A_withChannels = bodyOf<PackageDto>(res1);
      expect(pkg1A_withChannels.channelCount).toBe(0);

      // Provider 1A Package 2: ACT Basic Utility (will remain WITHOUT channels)
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1A.id,
          name: 'ACT Utility Plan',
          slug: `act-utility-${unique()}`,
          packageType: 'base',
          price: '99.00',
          billingCycle: 'monthly',
        },
      });
      expect(res2.statusCode).toBe(201);
      pkg1A_noChannels = bodyOf<PackageDto>(res2);
      expect(pkg1A_noChannels.channelCount).toBe(0);

      // Provider 1B Package 1: Hathway Value Bouquet (will have channels)
      const res3 = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1B.id,
          name: 'Hathway Value Bouquet',
          slug: `hw-value-${unique()}`,
          packageType: 'bouquet',
          price: '299.00',
          msoShare: '150.00',
          billingCycle: 'monthly',
        },
      });
      expect(res3.statusCode).toBe(201);
      pkg1B_withChannels = bodyOf<PackageDto>(res3);

      // Provider 1B Package 2: Hathway Zero Channel Plan (WITHOUT channels)
      const res4 = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1B.id,
          name: 'Hathway Zero Channel',
          slug: `hw-zero-${unique()}`,
          packageType: 'ala_carte',
          price: '50.00',
          billingCycle: 'monthly',
        },
      });
      expect(res4.statusCode).toBe(201);
      pkg1B_noChannels = bodyOf<PackageDto>(res4);

      // Provider 2A (Broadband) Package: Fiber 100 Mbps (WITHOUT channels)
      const res5 = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider2A.id,
          name: 'Fiber 100 Mbps Unlimited',
          slug: `fiber-100-${unique()}`,
          packageType: 'base',
          price: '599.00',
          billingCycle: 'monthly',
        },
      });
      expect(res5.statusCode).toBe(201);
      pkg2A_noChannels = bodyOf<PackageDto>(res5);
    });

    it('enforces slug uniqueness per provider, while allowing different providers to share package slugs', async () => {
      const commonSlug = `basic-${unique()}`;

      // Provider 1A creates commonSlug
      const resA = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1A.id,
          name: 'Basic Pack A',
          slug: commonSlug,
          price: '100.00',
        },
      });
      expect(resA.statusCode).toBe(201);

      // Provider 1B creates commonSlug -> allowed because different provider!
      const resB = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1B.id,
          name: 'Basic Pack B',
          slug: commonSlug,
          price: '100.00',
        },
      });
      expect(resB.statusCode).toBe(201);

      // Provider 1A attempts to create commonSlug again -> 409 conflict
      const resAClash = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1A.id,
          name: 'Basic Pack Duplicate',
          slug: commonSlug,
          price: '120.00',
        },
      });
      expect(resAClash.statusCode).toBe(409);
      expect(bodyOf(resAClash).code).toBe('RESOURCE_CONFLICT');
    });

    it('updates package details (e.g. price, name) via PATCH /api/v1/packages/:id', async () => {
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/packages/${pkg1A_withChannels.id}`,
        headers: adminAuthA,
        payload: {
          name: 'ACT Starter Bouquet Updated',
          price: '269.00',
        },
      });
      expect(patchRes.statusCode).toBe(200);
      const updated = bodyOf<PackageDto>(patchRes);
      expect(updated.name).toBe('ACT Starter Bouquet Updated');
      expect(updated.price).toBe('269.00');
      expect(updated.serviceProviderId).toBe(provider1A.id);
    });
  });

  describe('3. Channels Lineup — Packages With vs. Packages Without Channels', () => {
    beforeAll(async () => {
      // Seed channels for Provider 1A
      ch1A_1 = await seedProviderChannel(provider1A.id, 101, 'Star Sports 1');
      ch1A_2 = await seedProviderChannel(provider1A.id, 102, 'Colors HD');
      ch1A_3 = await seedProviderChannel(provider1A.id, 103, 'Discovery Channel');

      // Seed channels for Provider 1B
      ch1B_1 = await seedProviderChannel(provider1B.id, 201, 'Zee Cinema');
      ch1B_2 = await seedProviderChannel(provider1B.id, 202, 'Sony Sab');
    });

    it('lists channels belonging to a specific provider via GET /api/v1/channels', async () => {
      const listA = await app.inject({
        method: 'GET',
        url: `/api/v1/channels?serviceProviderId=${provider1A.id}`,
        headers: adminAuthA,
      });
      expect(listA.statusCode).toBe(200);
      const channelsA = bodyOf<PaginatedResponse<{ id: string; name: string }>>(listA);
      expect(channelsA.items.map(c => c.id)).toEqual(expect.arrayContaining([ch1A_1, ch1A_2, ch1A_3]));
      expect(channelsA.items.some(c => c.id === ch1B_1)).toBe(false);

      const listB = await app.inject({
        method: 'GET',
        url: `/api/v1/channels?serviceProviderId=${provider1B.id}`,
        headers: adminAuthA,
      });
      expect(listB.statusCode).toBe(200);
      const channelsB = bodyOf<PaginatedResponse<{ id: string; name: string }>>(listB);
      expect(channelsB.items.map(c => c.id)).toEqual(expect.arrayContaining([ch1B_1, ch1B_2]));
      expect(channelsB.items.some(c => c.id === ch1A_1)).toBe(false);
    });

    it('verifies packages without channels return channelCount: 0 and channels: []', async () => {
      // Check Provider 1A utility package
      const res1A = await app.inject({
        method: 'GET',
        url: `/api/v1/packages/${pkg1A_noChannels.id}`,
        headers: adminAuthA,
      });
      expect(res1A.statusCode).toBe(200);
      const detail1A = bodyOf<PackageDetailDto>(res1A);
      expect(detail1A.channelCount).toBe(0);
      expect(detail1A.channels).toEqual([]);

      // Check Provider 1B zero-channel package
      const res1B = await app.inject({
        method: 'GET',
        url: `/api/v1/packages/${pkg1B_noChannels.id}`,
        headers: adminAuthA,
      });
      expect(res1B.statusCode).toBe(200);
      const detail1B = bodyOf<PackageDetailDto>(res1B);
      expect(detail1B.channelCount).toBe(0);
      expect(detail1B.channels).toEqual([]);

      // Check Broadband package
      const res2A = await app.inject({
        method: 'GET',
        url: `/api/v1/packages/${pkg2A_noChannels.id}`,
        headers: adminAuthA,
      });
      expect(res2A.statusCode).toBe(200);
      const detail2A = bodyOf<PackageDetailDto>(res2A);
      expect(detail2A.channelCount).toBe(0);
      expect(detail2A.channels).toEqual([]);
    });

    it('attaches channels to packages via PUT /packages/:id/channels and verifies detailed lineup', async () => {
      // Attach 2 channels to Provider 1A's package
      const set1A = await app.inject({
        method: 'PUT',
        url: `/api/v1/packages/${pkg1A_withChannels.id}/channels`,
        headers: adminAuthA,
        payload: {
          channels: [
            { channelId: ch1A_1, isMandatory: true },
            { channelId: ch1A_2, isMandatory: false },
          ],
        },
      });
      expect(set1A.statusCode).toBe(200);
      const updated1A = bodyOf<PackageDetailDto>(set1A);
      expect(updated1A.channelCount).toBe(2);
      expect(updated1A.channels.map(c => c.id)).toEqual([ch1A_1, ch1A_2]);

      // Verify with GET /packages/:id
      const read1A = bodyOf<PackageDetailDto>(await app.inject({
        method: 'GET',
        url: `/api/v1/packages/${pkg1A_withChannels.id}`,
        headers: adminAuthA,
      }));
      expect(read1A.channelCount).toBe(2);
      expect(read1A.channels.length).toBe(2);
      expect(read1A.channels[0]?.name).toBe('Star Sports 1');
      expect(read1A.channels[0]?.isMandatory).toBe(true);
      expect(read1A.channels[1]?.name).toBe('Colors HD');
      expect(read1A.channels[1]?.isMandatory).toBe(false);

      // Attach channels to Provider 1B's package
      const set1B = await app.inject({
        method: 'PUT',
        url: `/api/v1/packages/${pkg1B_withChannels.id}/channels`,
        headers: adminAuthA,
        payload: {
          channels: [
            { channelId: ch1B_1 },
            { channelId: ch1B_2 },
          ],
        },
      });
      expect(set1B.statusCode).toBe(200);
      const updated1B = bodyOf<PackageDetailDto>(set1B);
      expect(updated1B.channelCount).toBe(2);
      expect(updated1B.channels.map(c => c.id)).toEqual([ch1B_1, ch1B_2]);
    });

    it('blocks attaching channels belonging to another provider (cross-provider protection)', async () => {
      // Attempt to attach Provider 1B channel to Provider 1A package
      const crossRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/packages/${pkg1A_withChannels.id}/channels`,
        headers: adminAuthA,
        payload: {
          channels: [
            { channelId: ch1A_1 },
            { channelId: ch1B_1 }, // Provider 1B channel!
          ],
        },
      });
      expect(crossRes.statusCode).toBe(400);
      expect(bodyOf(crossRes).code).toBe('VALIDATION_FAILED');
      expect(bodyOf(crossRes).message).toContain('Every channel must belong to this package’s provider');

      // Verify lineup for pkg1A remains unmodified
      const checkRes = bodyOf<PackageDetailDto>(await app.inject({
        method: 'GET',
        url: `/api/v1/packages/${pkg1A_withChannels.id}`,
        headers: adminAuthA,
      }));
      expect(checkRes.channelCount).toBe(2);
      expect(checkRes.channels.map(c => c.id)).toEqual([ch1A_1, ch1A_2]);
    });

    it('blocks assigning duplicate channel IDs in a single package lineup (400 VALIDATION_FAILED)', async () => {
      const dupRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/packages/${pkg1A_withChannels.id}/channels`,
        headers: adminAuthA,
        payload: {
          channels: [
            { channelId: ch1A_1 },
            { channelId: ch1A_1 }, // Duplicate!
          ],
        },
      });
      expect(dupRes.statusCode).toBe(400);
      expect(bodyOf(dupRes).code).toBe('VALIDATION_FAILED');
    });

    it('clears channel lineup when sending empty array { channels: [] }', async () => {
      // Empty the lineup
      const clearRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/packages/${pkg1A_withChannels.id}/channels`,
        headers: adminAuthA,
        payload: { channels: [] },
      });
      expect(clearRes.statusCode).toBe(200);
      const cleared = bodyOf<PackageDetailDto>(clearRes);
      expect(cleared.channelCount).toBe(0);
      expect(cleared.channels).toEqual([]);

      // Restore lineup for subsequent query tests
      const restoreRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/packages/${pkg1A_withChannels.id}/channels`,
        headers: adminAuthA,
        payload: {
          channels: [
            { channelId: ch1A_1 },
            { channelId: ch1A_2 },
            { channelId: ch1A_3 },
          ],
        },
      });
      expect(restoreRes.statusCode).toBe(200);
      expect(bodyOf<PackageDetailDto>(restoreRes).channelCount).toBe(3);
    });
  });

  describe('4. Cross-Entity Filtering & Queries', () => {
    it('filters packages by serviceId across all providers of that service', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/packages?serviceId=${cableService.id}`,
        headers: adminAuthA,
      });
      expect(res.statusCode).toBe(200);
      const page = bodyOf<PaginatedResponse<PackageDto>>(res);

      // Cable has packages from Provider 1A and Provider 1B
      const providerIds = new Set(page.items.map(p => p.serviceProviderId));
      expect(providerIds.has(provider1A.id)).toBe(true);
      expect(providerIds.has(provider1B.id)).toBe(true);
      // But NOT from Provider 2A (Broadband)
      expect(providerIds.has(provider2A.id)).toBe(false);
    });

    it('filters packages by serviceProviderId exclusively', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/packages?serviceProviderId=${provider1A.id}`,
        headers: adminAuthA,
      });
      expect(res.statusCode).toBe(200);
      const page = bodyOf<PaginatedResponse<PackageDto>>(res);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every(p => p.serviceProviderId === provider1A.id)).toBe(true);
    });

    it('filters packages by search query (q) and packageType', async () => {
      const searchRes = await app.inject({
        method: 'GET',
        url: '/api/v1/packages?q=Starter',
        headers: adminAuthA,
      });
      expect(searchRes.statusCode).toBe(200);
      const searchPage = bodyOf<PaginatedResponse<PackageDto>>(searchRes);
      expect(searchPage.items.some(p => p.name.includes('Starter'))).toBe(true);

      const typeRes = await app.inject({
        method: 'GET',
        url: '/api/v1/packages?packageType=bouquet',
        headers: adminAuthA,
      });
      expect(typeRes.statusCode).toBe(200);
      const typePage = bodyOf<PaginatedResponse<PackageDto>>(typeRes);
      expect(typePage.items.every(p => p.packageType === 'bouquet')).toBe(true);
    });
  });

  describe('5. Lifecycle & Deletion Constraints', () => {
    it('refuses to delete a service that still has providers (409 RESOURCE_IN_USE)', async () => {
      const deleteServiceRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/services/${cableService.id}`,
        headers: adminAuthA,
      });
      expect(deleteServiceRes.statusCode).toBe(409);
      expect(bodyOf(deleteServiceRes).code).toBe('RESOURCE_IN_USE');
    });

    it('allows deleting an unreferenced provider with 204 No Content', async () => {
      // provider1C (Den Networks) has no packages or subscriptions
      const deleteProviderRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/service-providers/${provider1C.id}`,
        headers: adminAuthA,
      });
      expect(deleteProviderRes.statusCode).toBe(204);

      // Subsequent read returns 404
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/service-providers/${provider1C.id}`,
        headers: adminAuthA,
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('allows deleting an unreferenced package and soft-deletes cleanly', async () => {
      // Create temporary package under Provider 2B
      const tempRes = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider2B.id,
          name: 'Temporary Promo Pack',
          slug: `temp-promo-${unique()}`,
          price: '1.00',
        },
      });
      expect(tempRes.statusCode).toBe(201);
      const tempPkg = bodyOf<PackageDto>(tempRes);

      // Delete it
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/packages/${tempPkg.id}`,
        headers: adminAuthA,
      });
      expect(deleteRes.statusCode).toBe(204);

      // Verify GET returns 404
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/packages/${tempPkg.id}`,
        headers: adminAuthA,
      });
      expect(getRes.statusCode).toBe(404);
      expect(bodyOf(getRes).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('6. Security & Multi-Tenancy Isolation', () => {
    it('returns 401 AUTH_HEADER_MISSING when authorization header is absent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/services',
      });
      expect(res.statusCode).toBe(401);
      expect(bodyOf(res).code).toBe('AUTH_HEADER_MISSING');
    });

    it('returns 403 PERM_DENIED when customer role attempts creating a service or package', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/services',
        headers: customerAuthA,
        payload: { name: 'Unauthorized Cable', slug: `unauth-${unique()}`, icon: 'tv' },
      });
      expect(createRes.statusCode).toBe(403);
      expect(bodyOf(createRes).code).toBe('PERM_DENIED');
    });

    it('ensures Tenant B admin cannot read, modify, or delete Tenant A resources (tenant isolation)', async () => {
      // Tenant B tries to read Tenant A's service
      const readRes = await app.inject({
        method: 'GET',
        url: `/api/v1/services/${cableService.id}`,
        headers: tenantBAdminAuth,
      });
      expect(readRes.statusCode).toBe(404);
      expect(bodyOf(readRes).code).toBe('RESOURCE_NOT_FOUND');

      // Tenant B tries to read Tenant A's provider
      const readProvRes = await app.inject({
        method: 'GET',
        url: `/api/v1/service-providers/${provider1A.id}`,
        headers: tenantBAdminAuth,
      });
      expect(readProvRes.statusCode).toBe(404);
      expect(bodyOf(readProvRes).code).toBe('RESOURCE_NOT_FOUND');

      // Tenant B tries to read Tenant A's package
      const readPkgRes = await app.inject({
        method: 'GET',
        url: `/api/v1/packages/${pkg1A_withChannels.id}`,
        headers: tenantBAdminAuth,
      });
      expect(readPkgRes.statusCode).toBe(404);
      expect(bodyOf(readPkgRes).code).toBe('RESOURCE_NOT_FOUND');

      // Tenant B tries to modify Tenant A's package channels
      const modRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/packages/${pkg1A_withChannels.id}/channels`,
        headers: tenantBAdminAuth,
        payload: { channels: [] },
      });
      expect(modRes.statusCode).toBe(404);
    });
  });

  describe('7. edge cases and payload validation rules', () => {
    it('rejects invalid money format on package create and update (400 VALIDATION_FAILED)', async () => {
      // Non-decimal string price
      const badPriceRes = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1A.id,
          name: 'Invalid Price Pack',
          slug: `bad-price-${unique()}`,
          price: 'not-a-number',
        },
      });
      expect(badPriceRes.statusCode).toBe(400);
      expect(bodyOf(badPriceRes).code).toBe('VALIDATION_FAILED');

      // More than 2 decimal places
      const badScaleRes = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1A.id,
          name: 'Three Decimal Pack',
          slug: `three-dec-${unique()}`,
          price: '99.999',
        },
      });
      expect(badScaleRes.statusCode).toBe(400);
      expect(bodyOf(badScaleRes).code).toBe('VALIDATION_FAILED');
    });

    it('rejects invalid packageType or billingCycle enum values', async () => {
      const badTypeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1A.id,
          name: 'Invalid Type Pack',
          slug: `bad-type-${unique()}`,
          packageType: 'non_existent_type',
        },
      });
      expect(badTypeRes.statusCode).toBe(400);
      expect(bodyOf(badTypeRes).code).toBe('VALIDATION_FAILED');

      const badCycleRes = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: provider1A.id,
          name: 'Invalid Cycle Pack',
          slug: `bad-cycle-${unique()}`,
          billingCycle: 'bi_weekly',
        },
      });
      expect(badCycleRes.statusCode).toBe(400);
      expect(bodyOf(badCycleRes).code).toBe('VALIDATION_FAILED');
    });

    it('returns 404 RESOURCE_NOT_FOUND when referencing non-existent service, provider, or package', async () => {
      const fakeId = randomUUID();

      // Non-existent service read
      const fakeService = await app.inject({
        method: 'GET',
        url: `/api/v1/services/${fakeId}`,
        headers: adminAuthA,
      });
      expect(fakeService.statusCode).toBe(404);
      expect(bodyOf(fakeService).code).toBe('RESOURCE_NOT_FOUND');

      // Create provider under non-existent service
      const fakeProvCreate = await app.inject({
        method: 'POST',
        url: '/api/v1/service-providers',
        headers: adminAuthA,
        payload: {
          serviceId: fakeId,
          name: 'Ghost Provider',
          slug: `ghost-${unique()}`,
        },
      });
      expect(fakeProvCreate.statusCode).toBe(404);
      expect(bodyOf(fakeProvCreate).code).toBe('RESOURCE_NOT_FOUND');

      // Create package under non-existent provider
      const fakePkgCreate = await app.inject({
        method: 'POST',
        url: '/api/v1/packages',
        headers: adminAuthA,
        payload: {
          serviceProviderId: fakeId,
          name: 'Ghost Package',
          slug: `ghost-pkg-${unique()}`,
        },
      });
      expect(fakePkgCreate.statusCode).toBe(404);
      expect(bodyOf(fakePkgCreate).code).toBe('RESOURCE_NOT_FOUND');

      // Non-existent channel in package lineup
      const fakeChannelLineup = await app.inject({
        method: 'PUT',
        url: `/api/v1/packages/${pkg1A_withChannels.id}/channels`,
        headers: adminAuthA,
        payload: {
          channels: [{ channelId: fakeId }],
        },
      });
      expect(fakeChannelLineup.statusCode).toBe(400);
      expect(bodyOf(fakeChannelLineup).code).toBe('VALIDATION_FAILED');
    });
  });
});

import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { tenantMemberships, users } from '@/db/schema';
import { hashPassword } from '@/security/password';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let adminAuthA: { 'authorization': string; 'x-tenant-id': string };
let areaCatId: string;
let streetCatId: string;
let schemaId: string;

async function login(email: string, password = TEST_PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: email, password },
  });

  return bodyOf<{ accessToken: string }>(response).accessToken;
}

function as(token: string, tenantId: string) {
  return { 'authorization': `Bearer ${token}`, 'x-tenant-id': tenantId };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  const token = await login(data.active.email);
  adminAuthA = as(token, data.tenantA.id);

  const areaRes = await app.inject({
    method: 'POST',
    url: '/api/v1/location-categories',
    headers: adminAuthA,
    payload: { name: 'Area', slug: `area-${randomUUID().slice(0, 6)}` },
  });
  areaCatId = bodyOf<{ id: string }>(areaRes).id;

  const streetRes = await app.inject({
    method: 'POST',
    url: '/api/v1/location-categories',
    headers: adminAuthA,
    payload: { name: 'Street', slug: `street-${randomUUID().slice(0, 6)}` },
  });
  streetCatId = bodyOf<{ id: string }>(streetRes).id;

  const schemaRes = await app.inject({
    method: 'POST',
    url: '/api/v1/location-schemas',
    headers: adminAuthA,
    payload: {
      name: 'Street Address',
      slug: `street-address-${randomUUID().slice(0, 6)}`,
      levels: [
        { categoryId: areaCatId, isTerminal: false },
        { categoryId: streetCatId, isTerminal: true },
      ],
    },
  });
  schemaId = bodyOf<{ id: string }>(schemaRes).id;
});

afterAll(async () => {
  await app.close();
  await data.cleanup();
  await close();
});

describe('location APIs edge cases and error responses', () => {
  describe('authentication and tenancy errors', () => {
    it('returns 401 AUTH_HEADER_MISSING when authorization header is omitted', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/locations',
      });
      expect(response.statusCode).toBe(401);
      expect(bodyOf(response).code).toBe('AUTH_HEADER_MISSING');
    });

    it('returns 401 AUTH_TOKEN_INVALID when token signature is invalid', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/locations',
        headers: { 'authorization': 'Bearer invalid.token.value', 'x-tenant-id': data.tenantA.id },
      });
      expect(response.statusCode).toBe(401);
      expect(bodyOf(response).code).toBe('AUTH_TOKEN_INVALID');
    });

    it('returns 400 TENANT_HEADER_MISSING when multi-tenant user omits x-tenant-id', async () => {
      const token = await login(data.active.email);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/locations',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response).code).toBe('TENANT_HEADER_MISSING');
    });

    it('returns 403 TENANT_NOT_A_MEMBER when supplying a tenant the user does not belong to', async () => {
      const token = await login(data.active.email);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/locations',
        headers: { 'authorization': `Bearer ${token}`, 'x-tenant-id': randomUUID() },
      });
      expect(response.statusCode).toBe(403);
      expect(bodyOf(response).code).toBe('TENANT_NOT_A_MEMBER');
    });

    it('returns 404 RESOURCE_NOT_FOUND when accessing another tenant’s location node (tenant isolation)', async () => {
      const nodeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { schemaId, name: `Private-${randomUUID().slice(0, 6)}` },
      });
      expect(nodeRes.statusCode).toBe(201);
      const nodeId = bodyOf<{ id: string }>(nodeRes).id;

      const [adminBUser] = await db.insert(users)
        .values({
          email: uniqueEmail('admin-b'),
          name: 'Tenant B Admin',
          passwordHash: await hashPassword(TEST_PASSWORD),
        })
        .returning();
      await db.insert(tenantMemberships)
        .values({ userId: adminBUser!.id, tenantId: data.tenantB.id, roleId: SYSTEM_ROLES.ADMIN });

      const tenantBAdminToken = await login(adminBUser!.email!);
      const tenantBAdminAuth = as(tenantBAdminToken, data.tenantB.id);

      const crossRes = await app.inject({
        method: 'GET',
        url: `/api/v1/locations/${nodeId}`,
        headers: tenantBAdminAuth,
      });
      expect(crossRes.statusCode).toBe(404);
      expect(bodyOf(crossRes).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('validation error edge cases', () => {
    it('returns 400 VALIDATION_FAILED on invalid UUID in route parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/locations/not-a-valid-uuid',
        headers: adminAuthA,
      });
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response).code).toBe('VALIDATION_FAILED');
    });

    it('returns 400 VALIDATION_FAILED when slug contains uppercase or invalid characters', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/location-categories',
        headers: adminAuthA,
        payload: { name: 'Bad Slug', slug: 'INVALID SLUG!' },
      });
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response).code).toBe('VALIDATION_FAILED');
    });

    it('returns 400 VALIDATION_FAILED when child category does not match schema depth', async () => {
      const areaRes = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { schemaId, name: `DepthTest-${randomUUID().slice(0, 6)}` },
      });
      const areaNode = bodyOf<{ id: string }>(areaRes);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { parentId: areaNode.id, name: 'Mismatched Category', categoryId: areaCatId },
      });
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response).code).toBe('VALIDATION_FAILED');
      expect(bodyOf(response).message).toContain('Level 1 of this schema is category');
    });

    it('returns 400 VALIDATION_FAILED when generate request exceeds the 2000 nodes cap', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/location-schemas/${schemaId}/generate`,
        headers: adminAuthA,
        payload: {
          levels: [{ count: 100 }, { count: 100 }],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response).code).toBe('VALIDATION_FAILED');
      expect(bodyOf(response).message).toContain('limit is 2000');
    });
  });

  describe('conflict and referential integrity edge cases', () => {
    it('returns 409 conflict when creating category with already existing slug', async () => {
      const slug = `unique-cat-${randomUUID().slice(0, 6)}`;
      await app.inject({
        method: 'POST',
        url: '/api/v1/location-categories',
        headers: adminAuthA,
        payload: { name: 'First Cat', slug },
      });

      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/v1/location-categories',
        headers: adminAuthA,
        payload: { name: 'Second Cat', slug },
      });
      expect(duplicate.statusCode).toBe(409);
    });

    it('returns 409 conflict when two siblings have the exact same name under a parent', async () => {
      const areaRes = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { schemaId, name: `AreaSiblings-${randomUUID().slice(0, 6)}` },
      });
      const areaId = bodyOf<{ id: string }>(areaRes).id;

      await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { parentId: areaId, name: 'Main Road' },
      });

      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { parentId: areaId, name: 'Main Road' },
      });
      expect(duplicate.statusCode).toBe(409);
    });

    it('returns 409 RESOURCE_IN_USE when deleting a category still referenced by a schema level', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/location-categories/${areaCatId}`,
        headers: adminAuthA,
      });
      expect(response.statusCode).toBe(409);
      expect(bodyOf(response).code).toBe('RESOURCE_IN_USE');
    });

    it('returns 409 RESOURCE_IN_USE when deleting a schema that still has location nodes', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/location-schemas/${schemaId}`,
        headers: adminAuthA,
      });
      expect(response.statusCode).toBe(409);
      expect(bodyOf(response).code).toBe('RESOURCE_IN_USE');
    });

    it('returns 409 RESOURCE_IN_USE when deleting a location node that still has children', async () => {
      const areaRes = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { schemaId, name: `ParentNode-${randomUUID().slice(0, 6)}` },
      });
      const areaId = bodyOf<{ id: string }>(areaRes).id;

      await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { parentId: areaId, name: 'Child Street' },
      });

      const deleteParentRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/locations/${areaId}`,
        headers: adminAuthA,
      });
      expect(deleteParentRes.statusCode).toBe(409);
      expect(bodyOf(deleteParentRes).code).toBe('RESOURCE_IN_USE');
    });

    it('returns 404 RESOURCE_NOT_FOUND when querying a non-existent location ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/locations/${randomUUID()}`,
        headers: adminAuthA,
      });
      expect(response.statusCode).toBe(404);
      expect(bodyOf(response).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('mandapeta gated community and village street hierarchy tests', () => {
    it('creates and traverses Mandapeta Gated community with Groups, Flats, and Doors (G1..G8, F1..F8, TF1)', async () => {
      const groupCat = bodyOf<{ id: string }>(await app.inject({
        method: 'POST',
        url: '/api/v1/location-categories',
        headers: adminAuthA,
        payload: { name: 'Group', slug: `group-${randomUUID().slice(0, 6)}` },
      }));

      const flatCat = bodyOf<{ id: string }>(await app.inject({
        method: 'POST',
        url: '/api/v1/location-categories',
        headers: adminAuthA,
        payload: { name: 'Flat', slug: `flat-${randomUUID().slice(0, 6)}` },
      }));

      const doorCat = bodyOf<{ id: string }>(await app.inject({
        method: 'POST',
        url: '/api/v1/location-categories',
        headers: adminAuthA,
        payload: { name: 'Door', slug: `door-${randomUUID().slice(0, 6)}` },
      }));

      const gatedSchema = bodyOf<{ id: string }>(await app.inject({
        method: 'POST',
        url: '/api/v1/location-schemas',
        headers: adminAuthA,
        payload: {
          name: 'Gated Apartment Hierarchy',
          slug: `gated-apartment-${randomUUID().slice(0, 6)}`,
          levels: [
            { categoryId: areaCatId, isTerminal: false },
            { categoryId: groupCat.id, isTerminal: false },
            { categoryId: flatCat.id, isTerminal: false },
            { categoryId: doorCat.id, isTerminal: true },
          ],
        },
      }));

      const gatedArea = bodyOf<{ id: string; name: string }>(await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { schemaId: gatedSchema.id, name: `Mandapeta Gated ${randomUUID().slice(0, 4)}` },
      }));

      const groupA = bodyOf<{ id: string }>(await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { parentId: gatedArea.id, name: 'Group A' },
      }));

      const flatA1 = bodyOf<{ id: string }>(await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: adminAuthA,
        payload: { parentId: groupA.id, name: 'A1' },
      }));

      const doorNames = [
        ...Array.from({ length: 8 }, (_, i) => `G${i + 1}`),
        ...Array.from({ length: 8 }, (_, i) => `F${i + 1}`),
        'TF1',
      ];

      const generateDoors = await app.inject({
        method: 'POST',
        url: `/api/v1/location-schemas/${gatedSchema.id}/generate`,
        headers: adminAuthA,
        payload: {
          parentId: flatA1.id,
          levels: [{ names: doorNames, nameFormat: '{label}' }],
        },
      });

      expect(generateDoors.statusCode).toBe(201);
      expect(bodyOf<{ created: number }>(generateDoors).created).toBe(17);

      const doorsList = bodyOf<{ total: number; items: { id: string; name: string; path: string }[] }>(await app.inject({
        method: 'GET',
        url: `/api/v1/locations?parentId=${flatA1.id}&limit=50`,
        headers: adminAuthA,
      }));

      expect(doorsList.total).toBe(17);
      const names = doorsList.items.map(d => d.name);
      expect(names).toContain('G1');
      expect(names).toContain('G8');
      expect(names).toContain('F1');
      expect(names).toContain('F8');
      expect(names).toContain('TF1');

      const g1Node = doorsList.items.find(d => d.name === 'G1')!;
      const g1Details = bodyOf<{ path: string; depth: number }>(await app.inject({
        method: 'GET',
        url: `/api/v1/locations/${g1Node.id}`,
        headers: adminAuthA,
      }));

      expect(g1Details.path).toBe(`${gatedArea.name} / Group A / A1 / G1`);
      expect(g1Details.depth).toBe(3);
    });

    it('creates standard village streets for Alamuru, Jonnada, and Dwarapudi', async () => {
      const villages = ['Alamuru', 'Jonnada', 'Dwarapudi'];
      for (const village of villages) {
        const villageRes = await app.inject({
          method: 'POST',
          url: '/api/v1/locations',
          headers: adminAuthA,
          payload: { schemaId, name: `${village} ${randomUUID().slice(0, 4)}` },
        });
        expect(villageRes.statusCode).toBe(201);
        const villageId = bodyOf<{ id: string }>(villageRes).id;

        const streetRes = await app.inject({
          method: 'POST',
          url: '/api/v1/locations',
          headers: adminAuthA,
          payload: { parentId: villageId, name: 'Main Road' },
        });
        expect(streetRes.statusCode).toBe(201);
        expect(bodyOf<{ path: string }>(streetRes).path).toContain('Main Road');
      }
    });
  });
});

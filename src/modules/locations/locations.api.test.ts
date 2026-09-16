import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { membershipLocations, rolePermissions, tenantMemberships, users } from '@/db/schema';
import { hashPassword } from '@/shared/security/password';
import { PERMISSIONS } from '@/shared/security/permissions';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let adminAuth: { 'authorization': string; 'x-tenant-id': string };
let categories: Record<string, string>;
let schemaId: string;

interface Node { id: string; name: string; path: string; depth: number; categoryId: string; status: string; source: string; aliases: string[] }
interface List { items: Node[]; total: number }

async function login(email: string, password = TEST_PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: email, password },
  });

  return bodyOf(response).accessToken;
}

function as(token: string, tenantId: string) {
  return { 'authorization': `Bearer ${token}`, 'x-tenant-id': tenantId };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  await db.insert(rolePermissions)
    .values([
      { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.LOCATIONS_VIEW, scope: 'LOCATION' as const },
      { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.LOCATIONS_CREATE, scope: 'LOCATION' as const },
    ])
    .onConflictDoNothing();

  adminAuth = as(await login(data.active.email), data.tenantA.id);

  const names = ['Area', 'Building', 'Block', 'Floor', 'Door'];
  categories = {};
  for (const name of names) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/location-categories',
      headers: adminAuth,
      payload: { name, slug: name.toLowerCase() },
    });
    expect(response.statusCode).toBe(201);
    categories[name] = bodyOf<{ id: string }>(response).id;
  }

  const schema = await app.inject({
    method: 'POST',
    url: '/api/v1/location-schemas',
    headers: adminAuth,
    payload: {
      name: 'Apartment',
      slug: 'apartment',
      levels: names.map(name => ({ categoryId: categories[name]! })),
    },
  });
  expect(schema.statusCode).toBe(201);
  schemaId = bodyOf<{ id: string }>(schema).id;
});

afterAll(async () => {
  await app.close();
  await data.cleanup();
  await close();
});

async function createNode(payload: Record<string, unknown>, headers = adminAuth) {
  return app.inject({ method: 'POST', url: '/api/v1/locations', headers, payload });
}

describe('location hierarchy configuration', () => {
  it('returns the levels root-first, with the leaf marked terminal', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/location-schemas', headers: adminAuth });
    const schemas = bodyOf<{ id: string; levels: { categorySlug: string; depth: number; isTerminal: boolean }[] }[]>(response);
    const apartment = schemas.find(s => s.id === schemaId)!;

    expect(apartment.levels.map(l => l.categorySlug)).toEqual(['area', 'building', 'block', 'floor', 'door']);
    expect(apartment.levels.at(-1)?.isTerminal).toBe(true);
  });

  it('refuses a category still used by a schema level', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/location-categories/${categories.Door}`,
      headers: adminAuth,
    });

    expect(response.statusCode).toBe(409);
    expect(bodyOf(response).code).toBe('RESOURCE_IN_USE');
  });
});

describe('location tree', () => {
  it('derives a node’s category from the schema, and its path from its parents', async () => {
    const area = await createNode({ schemaId, name: `Mandapeta ${randomUUID().slice(0, 6)}` });
    expect(area.statusCode).toBe(201);
    const areaNode = bodyOf<Node>(area);
    expect(areaNode.categoryId).toBe(categories.Area);
    expect(areaNode.depth).toBe(0);

    const building = bodyOf<Node>(await createNode({ parentId: areaNode.id, name: 'Sri Sai Apartments', aliases: ['SSA'] }));
    expect(building.categoryId).toBe(categories.Building);
    expect(building.path).toBe(`${areaNode.name} / Sri Sai Apartments`);
    expect(building.aliases).toEqual(['SSA']);
  });

  it('hands back the chain to a node, with the page each step sits on', async () => {
    const area = bodyOf<Node>(await createNode({ schemaId, name: `Reveal ${randomUUID().slice(0, 6)}` }));
    const building = bodyOf<Node>(await createNode({ parentId: area.id, name: 'Tower B' }));
    const block = bodyOf<Node>(await createNode({ parentId: building.id, name: 'Block C' }));

    await createNode({ parentId: area.id, name: 'Tower A' });
    await createNode({ parentId: area.id, name: 'Tower C' });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${block.id}/ancestors`,
      headers: adminAuth,
    });

    expect(response.statusCode).toBe(200);
    const chain = bodyOf<(Node & { siblingIndex: number })[]>(response);

    expect(chain.map(step => step.id)).toEqual([area.id, building.id, block.id]);

    expect(chain[1]?.siblingIndex).toBe(1);
    expect(chain[2]?.siblingIndex).toBe(0);
  });

  it('refuses the chain for a node outside the caller’s reach', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${randomUUID()}/ancestors`,
      headers: adminAuth,
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a category that is not the schema’s next level', async () => {
    const area = bodyOf<Node>(await createNode({ schemaId, name: `Yeditha ${randomUUID().slice(0, 6)}` }));

    const response = await createNode({ parentId: area.id, name: 'Wrong', categoryId: categories.Door });

    expect(response.statusCode).toBe(400);
    expect(bodyOf(response).code).toBe('VALIDATION_FAILED');
  });

  it('refuses two siblings with the same name', async () => {
    const area = bodyOf<Node>(await createNode({ schemaId, name: `Kapileswarapuram ${randomUUID().slice(0, 6)}` }));
    await createNode({ parentId: area.id, name: 'Twice' });

    const response = await createNode({ parentId: area.id, name: 'Twice' });

    expect(response.statusCode).toBe(409);
  });

  it('generates a subtree, cascading codes into door numbers', async () => {
    const area = bodyOf<Node>(await createNode({ schemaId, name: `Gollaprolu ${randomUUID().slice(0, 6)}` }));
    const building = bodyOf<Node>(await createNode({ parentId: area.id, name: 'Green Heights' }));

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/location-schemas/${schemaId}/generate`,
      headers: adminAuth,
      payload: {
        parentId: building.id,
        levels: [
          { names: ['A', 'B'], nameFormat: 'Block {label}', codeFormat: '{label}' },
          { count: 2, nameFormat: 'Floor {i}', codeFormat: '{parentCode}{i}' },
          { count: 4, nameFormat: '{parentCode}{i2}', codeFormat: '{name}' },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(bodyOf<{ created: number }>(response).created).toBe(22);

    const doors = bodyOf<List>(await app.inject({
      method: 'GET',
      url: `/api/v1/locations?ancestorId=${building.id}&categoryId=${categories.Door}&limit=100`,
      headers: adminAuth,
    }));

    expect(doors.total).toBe(16);
    expect(doors.items.map(d => d.name)).toContain('A101');
    expect(doors.items.map(d => d.name)).toContain('B204');
  });

  it('refuses a generation larger than the cap before writing anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/location-schemas/${schemaId}/generate`,
      headers: adminAuth,
      payload: { levels: [{ count: 50 }, { count: 50 }, { count: 50 }] },
    });

    expect(response.statusCode).toBe(400);
    expect(bodyOf(response).message).toContain('limit is 2000');
  });

  it('finds a building by an alias from the old ledger', async () => {
    const area = bodyOf<Node>(await createNode({ schemaId, name: `Ramachandrapuram ${randomUUID().slice(0, 6)}` }));
    await createNode({ parentId: area.id, name: 'Lakshmi Towers', aliases: ['LT', 'Laxmi Towers'] });

    const found = bodyOf<List>(await app.inject({
      method: 'GET',
      url: '/api/v1/locations?q=Laxmi',
      headers: adminAuth,
    }));

    expect(found.items.map(i => i.name)).toContain('Lakshmi Towers');
  });

  it('will not delete a node that still has children, and is idempotent on a leaf', async () => {
    const area = bodyOf<Node>(await createNode({ schemaId, name: `Anaparthi ${randomUUID().slice(0, 6)}` }));
    const building = bodyOf<Node>(await createNode({ parentId: area.id, name: 'Tower One' }));

    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/locations/${area.id}`, headers: adminAuth });
    expect(blocked.statusCode).toBe(409);
    expect(bodyOf(blocked).code).toBe('RESOURCE_IN_USE');

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/locations/${building.id}`, headers: adminAuth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/locations/${building.id}`, headers: adminAuth })).statusCode).toBe(204);
  });
});

describe('the global guard', () => {
  it('refuses an unauthenticated request, without the route declaring anything', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/locations' });

    expect(response.statusCode).toBe(401);
    expect(bodyOf(response).code).toBe('AUTH_HEADER_MISSING');
  });

  it('takes the tenant from the token when the caller belongs to exactly one', async () => {
    const [solo] = await db.insert(users)
      .values({ email: uniqueEmail('solo'), name: 'Single Tenant Admin', passwordHash: await hashPassword(TEST_PASSWORD) })
      .returning();
    await db.insert(tenantMemberships)
      .values({ userId: solo!.id, tenantId: data.tenantA.id, roleId: SYSTEM_ROLES.ADMIN });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/locations',
      headers: { authorization: `Bearer ${await login(solo!.email!)}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('asks a multi-tenant caller which tenant they mean', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/locations',
      headers: { authorization: adminAuth.authorization },
    });

    expect(response.statusCode).toBe(400);
    expect(bodyOf(response).code).toBe('TENANT_HEADER_MISSING');
  });
});

describe('tenant isolation and scope', () => {
  it('answers 404 for another tenant’s node, never a distinct code', async () => {
    const node = bodyOf<Node>(await createNode({ schemaId, name: `Draksharama ${randomUUID().slice(0, 6)}` }));

    const [outsider] = await db.insert(users)
      .values({ email: uniqueEmail('outsider'), name: 'Outsider', passwordHash: await hashPassword(TEST_PASSWORD) })
      .returning();
    await db.insert(tenantMemberships)
      .values({ userId: outsider!.id, tenantId: data.tenantB.id, roleId: SYSTEM_ROLES.ADMIN });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${node.id}`,
      headers: as(await login(outsider!.email!), data.tenantB.id),
    });

    expect(response.statusCode).toBe(404);
    expect(bodyOf(response).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('shows a scoped member their granted subtree and nothing else', async () => {
    const area = bodyOf<Node>(await createNode({ schemaId, name: `Rajahmundry ${randomUUID().slice(0, 6)}` }));
    const granted = bodyOf<Node>(await createNode({ parentId: area.id, name: 'Granted Towers' }));
    const hidden = bodyOf<Node>(await createNode({ parentId: area.id, name: 'Hidden Towers' }));

    const [staff] = await db.insert(users)
      .values({ email: uniqueEmail('staff'), name: 'Field Staff', passwordHash: await hashPassword(TEST_PASSWORD) })
      .returning();
    const [membership] = await db.insert(tenantMemberships)
      .values({ userId: staff!.id, tenantId: data.tenantA.id, roleId: SYSTEM_ROLES.STAFF })
      .returning();

    const staffAuth = as(await login(staff!.email!), data.tenantA.id);

    expect(bodyOf<List>(await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staffAuth })).total).toBe(0);

    await db.insert(membershipLocations).values({ membershipId: membership!.id, locationId: granted.id });
    app.access.invalidate(staff!.id, data.tenantA.id);

    const visible = bodyOf<List>(await app.inject({ method: 'GET', url: '/api/v1/locations?limit=100', headers: staffAuth }));
    expect(visible.items.map(i => i.name)).toEqual(['Granted Towers']);

    const outside = await app.inject({ method: 'GET', url: `/api/v1/locations/${hidden.id}`, headers: staffAuth });
    expect(outside.statusCode).toBe(403);
    expect(bodyOf(outside).code).toBe('PERM_SCOPE_DENIED');
  });

  it('records a field-added node as pending review, whatever the client asked for', async () => {
    const area = bodyOf<Node>(await createNode({ schemaId, name: `Peddapuram ${randomUUID().slice(0, 6)}` }));
    const building = bodyOf<Node>(await createNode({ parentId: area.id, name: 'Operator Towers' }));

    const [staff] = await db.insert(users)
      .values({ email: uniqueEmail('staff2'), name: 'Field Staff 2', passwordHash: await hashPassword(TEST_PASSWORD) })
      .returning();
    const [membership] = await db.insert(tenantMemberships)
      .values({ userId: staff!.id, tenantId: data.tenantA.id, roleId: SYSTEM_ROLES.STAFF })
      .returning();
    await db.insert(membershipLocations).values({ membershipId: membership!.id, locationId: building.id });

    const staffAuth = as(await login(staff!.email!), data.tenantA.id);
    const added = await createNode({ parentId: building.id, name: 'Block Z', status: 'approved' }, staffAuth);

    expect(added.statusCode).toBe(201);
    expect(bodyOf<Node>(added).source).toBe('user');
    expect(bodyOf<Node>(added).status).toBe('pending');
  });
});

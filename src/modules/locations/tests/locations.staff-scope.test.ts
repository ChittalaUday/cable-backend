import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import {
  membershipLocations,
  rolePermissions,
  teamLocations,
  teams,
  tenantMemberships,
  users,
} from '@/db/schema';
import { hashPassword } from '@/security/password';
import { PERMISSIONS } from '@/security/permissions';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let adminAuth: { 'authorization': string; 'x-tenant-id': string };

let mandapetaAreaId: string;
let tidcoBuildingId: string;
let blockId: string;

let kapileswaramAreaId: string;
let streetId: string;

let schemaId: string;
let categories: Record<string, string>;

// 5 staff credentials / auth headers
let staff1Auth: { 'authorization': string; 'x-tenant-id': string }; // Mandapeta Team 1 Leader
let staff2Auth: { 'authorization': string; 'x-tenant-id': string }; // Mandapeta Team 1 Staff
let staff3Auth: { 'authorization': string; 'x-tenant-id': string }; // Mandapeta Team 2 Leader
let staff4Auth: { 'authorization': string; 'x-tenant-id': string }; // Kapileswarapuram Staff
let staff5Auth: { 'authorization': string; 'x-tenant-id': string }; // All Locations Staff
let staffChildOnlyAuth: { 'authorization': string; 'x-tenant-id': string }; // Staff assigned ONLY to TIDCO Building (child)

interface NodeResponse {
  id: string;
  name: string;
  parentId: string | null;
  categoryId: string;
  isActive: boolean;
}

interface ListResponse {
  items: NodeResponse[];
  total: number;
}

async function login(email: string, password = TEST_PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: email, password },
  });
  expect(response.statusCode).toBe(200);
  return bodyOf<{ accessToken: string }>(response).accessToken;
}

function as(token: string, tenantId: string) {
  return { 'authorization': `Bearer ${token}`, 'x-tenant-id': tenantId };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  adminAuth = as(await login(data.active.email), data.tenantA.id);

  // Ensure staff role has location view, create, update, delete permissions with LOCATION scope
  await db.insert(rolePermissions).values([
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.LOCATIONS_VIEW, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.LOCATIONS_CREATE, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.LOCATIONS_UPDATE, scope: 'LOCATION' as const },
    { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.LOCATIONS_DELETE, scope: 'LOCATION' as const },
  ]).onConflictDoNothing();

  // Create Categories: Area -> Building -> Block -> Door
  const names = ['Area', 'Building', 'Block', 'Door'];
  categories = {};
  for (const name of names) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/location-categories',
      headers: adminAuth,
      payload: { name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}` },
    });
    expect(res.statusCode).toBe(201);
    categories[name] = bodyOf<{ id: string }>(res).id;
  }

  // Create Hierarchy Schema
  const schemaRes = await app.inject({
    method: 'POST',
    url: '/api/v1/location-schemas',
    headers: adminAuth,
    payload: {
      name: 'Town Hierarchy',
      slug: `town-${randomUUID().slice(0, 6)}`,
      levels: names.map((name, idx) => ({
        categoryId: categories[name]!,
        isTerminal: idx === names.length - 1,
      })),
    },
  });
  expect(schemaRes.statusCode).toBe(201);
  schemaId = bodyOf<{ id: string }>(schemaRes).id;

  // Create Locations:
  // 1. Mandapeta (Area) -> TIDCO Complex (Building) -> Block A (Block)
  const mdpRes = await app.inject({
    method: 'POST',
    url: '/api/v1/locations',
    headers: adminAuth,
    payload: { schemaId, name: 'Mandapeta' },
  });
  expect(mdpRes.statusCode).toBe(201);
  mandapetaAreaId = bodyOf<{ id: string }>(mdpRes).id;

  const tidcoRes = await app.inject({
    method: 'POST',
    url: '/api/v1/locations',
    headers: adminAuth,
    payload: { parentId: mandapetaAreaId, name: 'TIDCO Complex' },
  });
  expect(tidcoRes.statusCode).toBe(201);
  tidcoBuildingId = bodyOf<{ id: string }>(tidcoRes).id;

  const blockRes = await app.inject({
    method: 'POST',
    url: '/api/v1/locations',
    headers: adminAuth,
    payload: { parentId: tidcoBuildingId, name: 'Block A' },
  });
  expect(blockRes.statusCode).toBe(201);
  blockId = bodyOf<{ id: string }>(blockRes).id;

  // 2. Kapileswarapuram (Area) -> Main Road (Building level)
  const kapRes = await app.inject({
    method: 'POST',
    url: '/api/v1/locations',
    headers: adminAuth,
    payload: { schemaId, name: 'Kapileswarapuram' },
  });
  expect(kapRes.statusCode).toBe(201);
  kapileswaramAreaId = bodyOf<{ id: string }>(kapRes).id;

  const streetRes = await app.inject({
    method: 'POST',
    url: '/api/v1/locations',
    headers: adminAuth,
    payload: { parentId: kapileswaramAreaId, name: 'Main Road' },
  });
  expect(streetRes.statusCode).toBe(201);
  streetId = bodyOf<{ id: string }>(streetRes).id;

  // Create 2 Teams in Mandapeta
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const [team1] = await db.insert(teams).values({
    tenantId: data.tenantA.id,
    name: 'Mandapeta Team 1',
    slug: `mandapeta-team-1-${randomUUID().slice(0, 6)}`,
  }).returning({ id: teams.id });

  const [team2] = await db.insert(teams).values({
    tenantId: data.tenantA.id,
    name: 'Mandapeta Team 2',
    slug: `mandapeta-team-2-${randomUUID().slice(0, 6)}`,
  }).returning({ id: teams.id });

  // Assign Mandapeta location to both teams
  await db.insert(teamLocations).values([
    { teamId: team1!.id, locationId: mandapetaAreaId },
    { teamId: team2!.id, locationId: mandapetaAreaId },
  ]);

  // Helper to create staff user + membership
  async function createStaffUser(email: string, teamId?: string | null) {
    const [user] = await db.insert(users).values({
      email,
      name: email.split('@')[0],
      passwordHash,
    }).returning({ id: users.id });

    const [membership] = await db.insert(tenantMemberships).values({
      userId: user!.id,
      tenantId: data.tenantA.id,
      roleId: SYSTEM_ROLES.STAFF,
      teamId: teamId ?? null,
      status: 'active',
    }).returning({ id: tenantMemberships.id });

    return { userId: user!.id, membershipId: membership!.id, email };
  }

  // 1. Staff 1: Mandapeta Team 1 Leader
  const staff1 = await createStaffUser(uniqueEmail('staff1-lead'), team1!.id);
  await db.update(teams).set({ leaderMembershipId: staff1.membershipId }).where(eq(teams.id, team1!.id));
  await db.insert(membershipLocations).values({ membershipId: staff1.membershipId, locationId: mandapetaAreaId });
  staff1Auth = as(await login(staff1.email), data.tenantA.id);

  // 2. Staff 2: Mandapeta Team 1 Staff Member
  const staff2 = await createStaffUser(uniqueEmail('staff2-member'), team1!.id);
  await db.insert(membershipLocations).values({ membershipId: staff2.membershipId, locationId: mandapetaAreaId });
  staff2Auth = as(await login(staff2.email), data.tenantA.id);

  // 3. Staff 3: Mandapeta Team 2 Leader
  const staff3 = await createStaffUser(uniqueEmail('staff3-lead'), team2!.id);
  await db.update(teams).set({ leaderMembershipId: staff3.membershipId }).where(eq(teams.id, team2!.id));
  await db.insert(membershipLocations).values({ membershipId: staff3.membershipId, locationId: mandapetaAreaId });
  staff3Auth = as(await login(staff3.email), data.tenantA.id);

  // 4. Staff 4: Kapileswarapuram Location Staff
  const staff4 = await createStaffUser(uniqueEmail('staff4-kap'), null);
  await db.insert(membershipLocations).values({ membershipId: staff4.membershipId, locationId: kapileswaramAreaId });
  staff4Auth = as(await login(staff4.email), data.tenantA.id);

  // 5. Staff 5: All Locations Staff (both Mandapeta and Kapileswaram)
  const staff5 = await createStaffUser(uniqueEmail('staff5-all'), null);
  await db.insert(membershipLocations).values([
    { membershipId: staff5.membershipId, locationId: mandapetaAreaId },
    { membershipId: staff5.membershipId, locationId: kapileswaramAreaId },
  ]);
  staff5Auth = as(await login(staff5.email), data.tenantA.id);

  // 6. Child-only staff: assigned ONLY to TIDCO Complex (cannot manage top parent Mandapeta)
  const childStaff = await createStaffUser(uniqueEmail('staff-child-only'), null);
  await db.insert(membershipLocations).values({ membershipId: childStaff.membershipId, locationId: tidcoBuildingId });
  staffChildOnlyAuth = as(await login(childStaff.email), data.tenantA.id);
});

afterAll(async () => {
  await app.close();
  await data.cleanup();
  await close();
});

describe('staff Location Scoping: GET operations', () => {
  it('mandapeta Team 1 Lead sees Mandapeta and its descendants, not Kapileswarapuram', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staff1Auth });
    expect(listRes.statusCode).toBe(200);
    const list = bodyOf<ListResponse>(listRes);
    const ids = list.items.map(i => i.id);

    expect(ids).toContain(mandapetaAreaId);
    expect(ids).toContain(tidcoBuildingId);
    expect(ids).toContain(blockId);
    expect(ids).not.toContain(kapileswaramAreaId);
    expect(ids).not.toContain(streetId);

    // Can GET assigned node
    const getRes = await app.inject({ method: 'GET', url: `/api/v1/locations/${mandapetaAreaId}`, headers: staff1Auth });
    expect(getRes.statusCode).toBe(200);

    // Cannot GET unassigned area
    const deniedRes = await app.inject({ method: 'GET', url: `/api/v1/locations/${kapileswaramAreaId}`, headers: staff1Auth });
    expect(deniedRes.statusCode).toBe(403);
  });

  it('mandapeta Team 1 Staff member sees Mandapeta and its descendants, not Kapileswarapuram', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staff2Auth });
    expect(listRes.statusCode).toBe(200);
    const list = bodyOf<ListResponse>(listRes);
    const ids = list.items.map(i => i.id);

    expect(ids).toContain(mandapetaAreaId);
    expect(ids).toContain(tidcoBuildingId);
    expect(ids).not.toContain(kapileswaramAreaId);

    const denied = await app.inject({ method: 'GET', url: `/api/v1/locations/${kapileswaramAreaId}`, headers: staff2Auth });
    expect(denied.statusCode).toBe(403);
  });

  it('mandapeta Team 2 Lead sees Mandapeta subtree and cannot access Kapileswarapuram', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staff3Auth });
    expect(listRes.statusCode).toBe(200);
    const list = bodyOf<ListResponse>(listRes);
    const ids = list.items.map(i => i.id);

    expect(ids).toContain(mandapetaAreaId);
    expect(ids).not.toContain(kapileswaramAreaId);

    const denied = await app.inject({ method: 'GET', url: `/api/v1/locations/${kapileswaramAreaId}`, headers: staff3Auth });
    expect(denied.statusCode).toBe(403);
  });

  it('kapileswarapuram Staff sees Kapileswarapuram subtree and cannot access Mandapeta', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staff4Auth });
    expect(listRes.statusCode).toBe(200);
    const list = bodyOf<ListResponse>(listRes);
    const ids = list.items.map(i => i.id);

    expect(ids).toContain(kapileswaramAreaId);
    expect(ids).toContain(streetId);
    expect(ids).not.toContain(mandapetaAreaId);
    expect(ids).not.toContain(tidcoBuildingId);

    const denied = await app.inject({ method: 'GET', url: `/api/v1/locations/${mandapetaAreaId}`, headers: staff4Auth });
    expect(denied.statusCode).toBe(403);
  });

  it('all-Locations Staff sees both Mandapeta and Kapileswarapuram trees', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staff5Auth });
    expect(listRes.statusCode).toBe(200);
    const list = bodyOf<ListResponse>(listRes);
    const ids = list.items.map(i => i.id);

    expect(ids).toContain(mandapetaAreaId);
    expect(ids).toContain(kapileswaramAreaId);

    const getMdp = await app.inject({ method: 'GET', url: `/api/v1/locations/${mandapetaAreaId}`, headers: staff5Auth });
    expect(getMdp.statusCode).toBe(200);

    const getKap = await app.inject({ method: 'GET', url: `/api/v1/locations/${kapileswaramAreaId}`, headers: staff5Auth });
    expect(getKap.statusCode).toBe(200);
  });

  it('child-only staff sees only their child node and its descendants, not the top parent', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staffChildOnlyAuth });
    expect(listRes.statusCode).toBe(200);
    const list = bodyOf<ListResponse>(listRes);
    const ids = list.items.map(i => i.id);

    expect(ids).toContain(tidcoBuildingId);
    expect(ids).toContain(blockId);
    // Mandapeta is above the granted node, so it is outside their subtree
    expect(ids).not.toContain(mandapetaAreaId);

    const denied = await app.inject({ method: 'GET', url: `/api/v1/locations/${mandapetaAreaId}`, headers: staffChildOnlyAuth });
    expect(denied.statusCode).toBe(403);
  });
});

describe('staff Location Scoping: CREATE operations', () => {
  it('refuses creation of a top parent / root location without an unrestricted grant', async () => {
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staff1Auth,
      payload: { schemaId, name: 'New Town Root' },
    });
    expect(res1.statusCode).toBe(403);
    expect(bodyOf(res1).code).toBe('PERM_SCOPE_DENIED');

    const res4 = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staff4Auth,
      payload: { schemaId, name: 'New Kapileswaram Root' },
    });
    expect(res4.statusCode).toBe(403);
  });

  it('allows Mandapeta staff and team leaders to create child locations under their assigned area', async () => {
    // Mandapeta Team 1 Lead creates under TIDCO Complex
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staff1Auth,
      payload: { parentId: tidcoBuildingId, name: 'Block B' },
    });
    expect(res1.statusCode).toBe(201);
    const created1 = bodyOf<NodeResponse>(res1);
    expect(created1.name).toBe('Block B');

    // Mandapeta Team 1 Member creates Door under Block B
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staff2Auth,
      payload: { parentId: created1.id, name: 'Door 101' },
    });
    expect(res2.statusCode).toBe(201);

    // Mandapeta Team 2 Lead creates under TIDCO Complex
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staff3Auth,
      payload: { parentId: tidcoBuildingId, name: 'Block C' },
    });
    expect(res3.statusCode).toBe(201);
  });

  it('refuses location creation under an area outside the staff member’s grant', async () => {
    // Mandapeta Lead tries to create in Kapileswarapuram
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staff1Auth,
      payload: { parentId: kapileswaramAreaId, name: 'Illegal Street' },
    });
    expect(res.statusCode).toBe(403);
    expect(bodyOf(res).code).toBe('PERM_SCOPE_DENIED');

    // Kapileswarapuram staff tries to create in Mandapeta
    const resKap = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staff4Auth,
      payload: { parentId: tidcoBuildingId, name: 'Illegal Block' },
    });
    expect(resKap.statusCode).toBe(403);
  });

  it('staff assigned only to a child node cannot create under the top parent (manages children only)', async () => {
    // child-only staff assigned to TIDCO Building CAN create a block under TIDCO Building
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staffChildOnlyAuth,
      payload: { parentId: tidcoBuildingId, name: 'Block D Child' },
    });
    expect(allowed.statusCode).toBe(201);

    // BUT cannot create directly under Mandapeta (top parent above TIDCO)
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staffChildOnlyAuth,
      payload: { parentId: mandapetaAreaId, name: 'Another Building' },
    });
    expect(denied.statusCode).toBe(403);
    expect(bodyOf(denied).code).toBe('PERM_SCOPE_DENIED');
  });
});

describe('staff Location Scoping: UPDATE operations', () => {
  it('allows staff to update locations within their assigned area and denies outside', async () => {
    // Mandapeta Lead updates Block A
    const okUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${blockId}`,
      headers: staff1Auth,
      payload: { name: 'Block A Renamed' },
    });
    expect(okUpdate.statusCode).toBe(200);
    expect(bodyOf<NodeResponse>(okUpdate).name).toBe('Block A Renamed');

    // Mandapeta Lead tries to update Street in Kapileswarapuram -> 403
    const deniedUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${streetId}`,
      headers: staff1Auth,
      payload: { name: 'Unauthorized Street' },
    });
    expect(deniedUpdate.statusCode).toBe(403);

    // Kapileswarapuram staff can update Street in Kapileswarapuram
    const kapUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${streetId}`,
      headers: staff4Auth,
      payload: { name: 'Main Road Updated' },
    });
    expect(kapUpdate.statusCode).toBe(200);

    // Child-only staff CANNOT update the top parent Mandapeta
    const childDenied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${mandapetaAreaId}`,
      headers: staffChildOnlyAuth,
      payload: { name: 'Mandapeta Hacked' },
    });
    expect(childDenied.statusCode).toBe(403);
  });
});

describe('staff Location Scoping: DELETE and SOFT DELETE', () => {
  it('refuses deletion of a location outside the staff member’s grant', async () => {
    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${streetId}`,
      headers: staff1Auth,
    });
    expect(denied.statusCode).toBe(403);
  });

  it('refuses deletion of a node that still has children', async () => {
    // TIDCO Complex still has Block A and others
    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${tidcoBuildingId}`,
      headers: staff1Auth,
    });
    expect(blocked.statusCode).toBe(409);
    expect(bodyOf(blocked).code).toBe('RESOURCE_IN_USE');
  });

  it('soft deletes a location (sets isActive = false) if a user or staff is assigned to it', async () => {
    // 1. Create a leaf door in Mandapeta
    const doorRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staff1Auth,
      payload: { parentId: blockId, name: 'Door 201 Assigned' },
    });
    expect(doorRes.statusCode).toBe(201);
    const doorId = bodyOf<NodeResponse>(doorRes).id;

    // 2. Assign a staff member to this door
    const [assignedStaff] = await db.select().from(tenantMemberships).where(eq(tenantMemberships.tenantId, data.tenantA.id)).limit(1);
    await db.insert(membershipLocations).values({
      membershipId: assignedStaff!.id,
      locationId: doorId,
    });

    // 3. Delete the door
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${doorId}`,
      headers: staff1Auth,
    });
    expect(delRes.statusCode).toBe(204);

    // 4. Verify it was SOFT DELETED: the row still exists, but isActive is false!
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${doorId}`,
      headers: adminAuth,
    });
    expect(getRes.statusCode).toBe(200);
    const node = bodyOf<NodeResponse>(getRes);
    expect(node.id).toBe(doorId);
    expect(node.isActive).toBe(false);
  });

  it('hard deletes a leaf location when no user or staff is assigned to it', async () => {
    // 1. Create an unassigned leaf door
    const doorRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: staff1Auth,
      payload: { parentId: blockId, name: 'Door 202 Clean Leaf' },
    });
    expect(doorRes.statusCode).toBe(201);
    const cleanDoorId = bodyOf<NodeResponse>(doorRes).id;

    // 2. Delete the door
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${cleanDoorId}`,
      headers: staff1Auth,
    });
    expect(delRes.statusCode).toBe(204);

    // 3. Verify it was HARD DELETED: row no longer exists in DB!
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${cleanDoorId}`,
      headers: adminAuth,
    });
    expect(getRes.statusCode).toBe(404);
  });
});

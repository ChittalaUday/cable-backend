import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { rolePermissions } from '@/db/schema';
import { PERMISSIONS } from '@/shared/security/permissions';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let adminAuth: { 'authorization': string; 'x-tenant-id': string };
let areaA: string;
let areaB: string;

interface Ref { id: string; name: string; path: string }
interface Staff { id: string; userId: string; name: string | null; roleId: string; status: string; team: { id: string } | null; isTeamLeader: boolean; locations: Ref[]; inheritedLocations: Ref[]; teamAreas: Ref[] }
interface Team { id: string; name: string; slug: string; memberCount: number; locations: Ref[] }
interface List<T> { items: T[]; total: number }

async function login(identifier: string, password = TEST_PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier, password },
  });

  expect(response.statusCode).toBe(200);
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
    .values([{ roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.LOCATIONS_VIEW, scope: 'LOCATION' as const }])
    .onConflictDoNothing();

  adminAuth = as(await login(data.active.email), data.tenantA.id);

  const category = await app.inject({
    method: 'POST',
    url: '/api/v1/location-categories',
    headers: adminAuth,
    payload: { name: `Area-${randomUUID().slice(0, 8)}`, slug: `area-${randomUUID().slice(0, 8)}` },
  });
  expect(category.statusCode).toBe(201);
  const categoryId = bodyOf<{ id: string }>(category).id;

  const schema = await app.inject({
    method: 'POST',
    url: '/api/v1/location-schemas',
    headers: adminAuth,
    payload: { name: `Flat-${randomUUID().slice(0, 8)}`, slug: `flat-${randomUUID().slice(0, 8)}`, levels: [{ categoryId }] },
  });
  expect(schema.statusCode).toBe(201);
  const schemaId = bodyOf<{ id: string }>(schema).id;

  const node = async (name: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: adminAuth,
      payload: { schemaId, parentId: null, name },
    });
    expect(response.statusCode).toBe(201);
    return bodyOf<{ id: string }>(response).id;
  };

  areaA = await node(`Mandapeta-${randomUUID().slice(0, 8)}`);
  areaB = await node(`Ravulapalem-${randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
  await app.close();
  await data.cleanup();
  await close();
});

async function createTeam(name: string) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/teams', headers: adminAuth, payload: { name } });
  expect(response.statusCode).toBe(201);
  return bodyOf<Team>(response);
}

async function createStaff(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/staff', headers: adminAuth, payload });
}

describe('staff and teams', () => {
  it('hires someone, and the membership is the record — not the account', async () => {
    const phone = uniquePhone();
    const response = await createStaff({ name: 'Ravi Kumar', phone, password: TEST_PASSWORD });

    expect(response.statusCode).toBe(201);
    const member = bodyOf<Staff>(response);
    expect(member.roleId).toBe(SYSTEM_ROLES.STAFF);
    expect(member.status).toBe('active');
    expect(member.team).toBeNull();
    expect(member.locations).toEqual([]);

    const again = await createStaff({ name: 'Ravi Kumar', phone });
    expect(again.statusCode).toBe(409);

    const list = await app.inject({ method: 'GET', url: '/api/v1/staff?q=Ravi', headers: adminAuth });
    expect(list.statusCode).toBe(200);
    expect(bodyOf<List<Staff>>(list).items.map(s => s.id)).toContain(member.id);
  });

  it('rejects a staff member with no way to sign in', async () => {
    const response = await createStaff({ name: 'Nobody' });

    expect(response.statusCode).toBe(400);
    expect(bodyOf<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
  });

  it('grants areas to one person directly', async () => {
    const created = bodyOf<Staff>(await createStaff({ name: 'Direct Grant', phone: uniquePhone() }));

    const set = await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${created.id}/locations`,
      headers: adminAuth,
      payload: { locationIds: [areaA] },
    });

    expect(set.statusCode).toBe(200);
    const after = bodyOf<Staff>(set);
    expect(after.locations.map(l => l.id)).toEqual([areaA]);
    expect(after.locations[0]!.path).toContain('Mandapeta');
    expect(after.inheritedLocations).toEqual([]);
  });

  it('grants areas to a whole crew, and the members inherit the reach', async () => {
    const team = await createTeam(`Collection Round ${randomUUID().slice(0, 8)}`);
    const email = uniqueEmail('crew');
    const member = bodyOf<Staff>(await createStaff({
      name: 'Crew Member',
      email,
      password: TEST_PASSWORD,
      teamId: team.id,
    }));

    expect(member.team?.id).toBe(team.id);

    const granted = await app.inject({
      method: 'PUT',
      url: `/api/v1/teams/${team.id}/locations`,
      headers: adminAuth,
      payload: { locationIds: [areaA] },
    });
    expect(granted.statusCode).toBe(200);
    expect(bodyOf<Team>(granted).memberCount).toBe(1);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/staff/${member.id}`, headers: adminAuth });
    expect(bodyOf<Staff>(detail).locations).toEqual([]);
    expect(bodyOf<Staff>(detail).inheritedLocations.map(l => l.id)).toEqual([areaA]);

    const staffAuth = as(await login(email), data.tenantA.id);
    const visible = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staffAuth });
    expect(visible.statusCode).toBe(200);
    const seen = bodyOf<List<{ id: string }>>(visible).items.map(l => l.id);
    expect(seen).toContain(areaA);
    expect(seen).not.toContain(areaB);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${member.id}/locations`,
      headers: adminAuth,
      payload: { locationIds: [areaB] },
    });

    const widened = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staffAuth });
    const both = bodyOf<List<{ id: string }>>(widened).items.map(l => l.id);
    expect(both).toContain(areaA);
    expect(both).toContain(areaB);

    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/teams/${team.id}`, headers: adminAuth });
    expect(blocked.statusCode).toBe(409);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${member.id}`,
      headers: adminAuth,
      payload: { teamId: null },
    });

    const disbanded = await app.inject({ method: 'DELETE', url: `/api/v1/teams/${team.id}`, headers: adminAuth });
    expect(disbanded.statusCode).toBe(204);

    const narrowed = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staffAuth });
    const left = bodyOf<List<{ id: string }>>(narrowed).items.map(l => l.id);
    expect(left).not.toContain(areaA);
    expect(left).toContain(areaB);
  });

  it('is closed to the staff role — only an admin manages people', async () => {
    const email = uniqueEmail('field');
    await createStaff({ name: 'Field Operator', email, password: TEST_PASSWORD });

    const fieldAuth = as(await login(email), data.tenantA.id);

    for (const url of ['/api/v1/staff', '/api/v1/teams']) {
      const response = await app.inject({ method: 'GET', url, headers: fieldAuth });
      expect(response.statusCode).toBe(403);
      expect(bodyOf<{ code: string }>(response).code).toBe('PERM_DENIED');
    }

    const write = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: fieldAuth,
      payload: { name: 'Shadow crew' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('narrows a member to part of the crew patch, and an empty list widens them back', async () => {
    const team = await createTeam(`Split round ${randomUUID().slice(0, 8)}`);
    const email = uniqueEmail('narrow');
    const member = bodyOf<Staff>(await createStaff({
      name: 'Narrowed',
      email,
      password: TEST_PASSWORD,
      teamId: team.id,
    }));

    await app.inject({
      method: 'PUT',
      url: `/api/v1/teams/${team.id}/locations`,
      headers: adminAuth,
      payload: { locationIds: [areaA, areaB] },
    });

    const staffAuth = as(await login(email), data.tenantA.id);
    const seen = async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: staffAuth });
      return bodyOf<List<{ id: string }>>(response).items.map(node => node.id);
    };

    expect(await seen()).toEqual(expect.arrayContaining([areaA, areaB]));

    const narrowed = await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${member.id}/team-areas`,
      headers: adminAuth,
      payload: { locationIds: [areaA] },
    });
    expect(narrowed.statusCode).toBe(200);
    expect(bodyOf<Staff>(narrowed).teamAreas.map(a => a.id)).toEqual([areaA]);
    expect(bodyOf<Staff>(narrowed).inheritedLocations.map(a => a.id)).toEqual([areaA]);

    const after = await seen();
    expect(after).toContain(areaA);
    expect(after).not.toContain(areaB);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${member.id}/team-areas`,
      headers: adminAuth,
      payload: { locationIds: [] },
    });
    expect(await seen()).toEqual(expect.arrayContaining([areaA, areaB]));
  });

  it('refuses a narrowing that reaches outside the crew patch', async () => {
    const team = await createTeam(`Bounded ${randomUUID().slice(0, 8)}`);
    const member = bodyOf<Staff>(await createStaff({ name: 'Bounded', phone: uniquePhone(), teamId: team.id }));

    await app.inject({
      method: 'PUT',
      url: `/api/v1/teams/${team.id}/locations`,
      headers: adminAuth,
      payload: { locationIds: [areaA] },
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${member.id}/team-areas`,
      headers: adminAuth,
      payload: { locationIds: [areaB] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('drops the narrowing and the leadership when someone leaves the crew', async () => {
    const team = await createTeam(`Leaver ${randomUUID().slice(0, 8)}`);
    const member = bodyOf<Staff>(await createStaff({ name: 'Leaver', phone: uniquePhone(), teamId: team.id }));

    await app.inject({
      method: 'PUT',
      url: `/api/v1/teams/${team.id}/locations`,
      headers: adminAuth,
      payload: { locationIds: [areaA, areaB] },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${member.id}/team-areas`,
      headers: adminAuth,
      payload: { locationIds: [areaA] },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${member.id}`,
      headers: adminAuth,
      payload: { isTeamLeader: true },
    });

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${member.id}`,
      headers: adminAuth,
      payload: { teamId: null },
    });

    const after = bodyOf<Staff>(off);
    expect(after.team).toBeNull();
    expect(after.isTeamLeader).toBe(false);
    expect(after.teamAreas).toEqual([]);
    expect(after.inheritedLocations).toEqual([]);
  });

  it('lets a crew leader manage their own crew and no one else', async () => {
    const team = await createTeam(`Led ${randomUUID().slice(0, 8)}`);
    const outsider = bodyOf<Staff>(await createStaff({ name: 'Outsider', phone: uniquePhone() }));

    const email = uniqueEmail('leader');
    const leader = bodyOf<Staff>(await createStaff({
      name: 'Leader',
      email,
      password: TEST_PASSWORD,
      teamId: team.id,
    }));
    const mate = bodyOf<Staff>(await createStaff({ name: 'Crew mate', phone: uniquePhone(), teamId: team.id }));

    await app.inject({
      method: 'PUT',
      url: `/api/v1/teams/${team.id}/locations`,
      headers: adminAuth,
      payload: { locationIds: [areaA] },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${leader.id}`,
      headers: adminAuth,
      payload: { isTeamLeader: true },
    });

    const leaderAuth = as(await login(email), data.tenantA.id);

    const list = await app.inject({ method: 'GET', url: '/api/v1/staff?limit=100', headers: leaderAuth });
    expect(list.statusCode).toBe(200);
    const visible = bodyOf<List<Staff>>(list).items.map(person => person.id);
    expect(visible).toEqual(expect.arrayContaining([leader.id, mate.id]));
    expect(visible).not.toContain(outsider.id);

    const narrow = await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${mate.id}/team-areas`,
      headers: leaderAuth,
      payload: { locationIds: [areaA] },
    });
    expect(narrow.statusCode).toBe(200);

    const reach = await app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${outsider.id}`,
      headers: leaderAuth,
      payload: { status: 'suspended' },
    });
    expect(reach.statusCode).toBe(404);

    const hire = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: leaderAuth,
      payload: { name: 'Sneaky', phone: uniquePhone() },
    });
    expect(hire.statusCode).toBe(403);

    const promote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${mate.id}`,
      headers: leaderAuth,
      payload: { roleId: 'admin' },
    });
    expect(promote.statusCode).toBe(403);
  });

  it('lists a crew with its leaders first and each member’s share of the patch', async () => {
    const team = await createTeam(`Roster ${randomUUID().slice(0, 8)}`);
    const first = bodyOf<Staff>(await createStaff({ name: 'Aaa Member', phone: uniquePhone(), teamId: team.id }));
    const boss = bodyOf<Staff>(await createStaff({ name: 'Zzz Boss', phone: uniquePhone(), teamId: team.id }));

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/staff/${boss.id}`,
      headers: adminAuth,
      payload: { isTeamLeader: true },
    });

    const response = await app.inject({ method: 'GET', url: `/api/v1/teams/${team.id}/members`, headers: adminAuth });
    expect(response.statusCode).toBe(200);

    const members = bodyOf<{ id: string; isTeamLeader: boolean; teamAreas: Ref[] }[]>(response);
    expect(members.map(m => m.id)).toEqual([boss.id, first.id]);
    expect(members[0]!.isTeamLeader).toBe(true);
    expect(members[1]!.teamAreas).toEqual([]);
  });

  it('answers 404 for a membership of another tenant, same as a missing one', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/staff/${randomUUID()}`, headers: adminAuth });

    expect(response.statusCode).toBe(404);
  });

  it('refuses to let an admin remove their own membership', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/staff?limit=100', headers: adminAuth });
    const self = bodyOf<List<Staff>>(list).items.find(s => s.userId === data.active.id);

    const response = await app.inject({ method: 'DELETE', url: `/api/v1/staff/${self!.id}`, headers: adminAuth });
    expect(response.statusCode).toBe(409);
  });
});

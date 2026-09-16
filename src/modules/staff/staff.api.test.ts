import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { rolePermissions } from '@/db/schema';
import { PERMISSIONS } from '@/security/permissions';
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
interface Staff { id: string; userId: string; email: string | null; name: string | null; roleId: string; status: string; team: { id: string } | null; isTeamLeader: boolean; locations: Ref[]; inheritedLocations: Ref[]; teamAreas: Ref[] }
interface Team { id: string; name: string; slug: string; memberCount: number; leaderMembershipId: string | null; locations: Ref[] }
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

async function appointLeader(teamId: string, membershipId: string | null) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/teams/${teamId}`,
    headers: adminAuth,
    payload: { leaderMembershipId: membershipId },
  });
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

  it('finds the same person however the address was capitalised', async () => {
    const address = `Ravi.Kumar-${randomUUID().slice(0, 8)}@Test.Local`;

    const first = await createStaff({ name: 'Ravi Kumar', email: address });
    expect(first.statusCode, first.body).toBe(201);
    expect(bodyOf<Staff>(first).email).toBe(address.toLowerCase());

    // The job ends, the account survives (§6.4) — so re-hiring has to find that
    // account whatever case the form is filled in this time. Failing to find it
    // is not a new account, it is a unique violation on an address that is
    // already taken, and the hire fails for a reason nobody can act on.
    const ended = await app.inject({ method: 'DELETE', url: `/api/v1/staff/${bodyOf<Staff>(first).id}`, headers: adminAuth });
    expect(ended.statusCode).toBe(204);

    const rehired = await createStaff({ name: 'Ravi Kumar', email: address.toUpperCase() });
    expect(rehired.statusCode, rehired.body).toBe(201);
    expect(bodyOf<Staff>(rehired).userId).toBe(bodyOf<Staff>(first).userId);
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
    expect(narrowed.statusCode, narrowed.body).toBe(200);
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
    expect((await appointLeader(team.id, member.id)).statusCode).toBe(200);

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

    const vacated = await app.inject({ method: 'GET', url: `/api/v1/teams/${team.id}`, headers: adminAuth });
    expect(bodyOf<Team>(vacated).leaderMembershipId).toBeNull();
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
    expect((await appointLeader(team.id, leader.id)).statusCode).toBe(200);

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

    expect((await appointLeader(team.id, boss.id)).statusCode).toBe(200);

    const response = await app.inject({ method: 'GET', url: `/api/v1/teams/${team.id}/members`, headers: adminAuth });
    expect(response.statusCode).toBe(200);

    const members = bodyOf<{ id: string; isTeamLeader: boolean; teamAreas: Ref[] }[]>(response);
    expect(members.map(m => m.id)).toEqual([boss.id, first.id]);
    expect(members[0]!.isTeamLeader).toBe(true);
    expect(members[1]!.teamAreas).toEqual([]);
  });

  it('lets a crew be led only by its own member, and only one crew per person', async () => {
    const one = await createTeam(`Led one ${randomUUID().slice(0, 8)}`);
    const two = await createTeam(`Led two ${randomUUID().slice(0, 8)}`);
    const member = bodyOf<Staff>(await createStaff({ name: 'Boss', phone: uniquePhone(), teamId: one.id }));
    const outsider = bodyOf<Staff>(await createStaff({ name: 'Outsider', phone: uniquePhone() }));

    expect((await appointLeader(one.id, outsider.id)).statusCode).toBe(400);
    expect((await appointLeader(one.id, member.id)).statusCode).toBe(200);

    // Already leads `one`, and is not on `two` either way.
    expect((await appointLeader(two.id, member.id)).statusCode).toBe(400);

    expect((await appointLeader(one.id, null)).statusCode).toBe(200);
    const vacated = await app.inject({ method: 'GET', url: `/api/v1/teams/${one.id}`, headers: adminAuth });
    expect(bodyOf<Team>(vacated).leaderMembershipId).toBeNull();
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

/**
 * `staffReach` and `teamReach` at `LOCATION` — the branch nothing exercised.
 *
 * Testing it means granting `staff.view` to the `staff` role, and the role
 * table only accepts the three system ids (`roles_known_id`), so there is no
 * private role to hang it on. The grant therefore lives and dies inside this
 * block: the earlier "closed to the staff role" test has already run, no other
 * file calls these routes, and `afterAll` puts the role back.
 */
describe('what an area lead sees of the people and crews below them', () => {
  let leadAuth: { 'authorization': string; 'x-tenant-id': string };
  let nomadAuth: { 'authorization': string; 'x-tenant-id': string };
  let areaNorth: string;
  let blockNorth: string;
  let areaSouth: string;
  let insider: Staff;
  let outsider: Staff;
  let unplaced: Staff;
  let crewMate: Staff;
  let crewNorth: Team;
  let crewSouth: Team;

  const AREA_KEYS = [PERMISSIONS.STAFF_VIEW, PERMISSIONS.STAFF_UPDATE] as const;

  const grantAreas = async (id: string, locationIds: string[], owner: 'staff' | 'teams' = 'staff') =>
    app.inject({ method: 'PUT', url: `/api/v1/${owner}/${id}/locations`, headers: adminAuth, payload: { locationIds } });

  const hire = async (name: string, extra: Record<string, unknown> = {}) => {
    const response = await createStaff({ name, phone: uniquePhone(), ...extra });
    expect(response.statusCode, response.body).toBe(201);
    return bodyOf<Staff>(response);
  };

  beforeAll(async () => {
    await db.insert(rolePermissions)
      .values(AREA_KEYS.map(permissionKey => ({ roleId: SYSTEM_ROLES.STAFF, permissionKey, scope: 'LOCATION' as const })))
      .onConflictDoUpdate({ target: [rolePermissions.roleId, rolePermissions.permissionKey], set: { scope: 'LOCATION' } });
    app.access.invalidate();

    // A grant reaches down the tree, so the areas need a level below them.
    const named = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
    const categoryOf = async (name: string) => bodyOf<{ id: string }>(await app.inject({
      method: 'POST',
      url: '/api/v1/location-categories',
      headers: adminAuth,
      payload: { name: named(name), slug: named(name.toLowerCase()) },
    })).id;

    const schemaId = bodyOf<{ id: string }>(await app.inject({
      method: 'POST',
      url: '/api/v1/location-schemas',
      headers: adminAuth,
      payload: {
        name: named('Two-level'),
        slug: named('two-level'),
        levels: [{ categoryId: await categoryOf('Zone') }, { categoryId: await categoryOf('Block') }],
      },
    })).id;

    const node = async (name: string, parentId: string | null) => bodyOf<{ id: string }>(await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: adminAuth,
      payload: { schemaId, parentId, name: named(name) },
    })).id;

    areaNorth = await node('North', null);
    blockNorth = await node('North Block', areaNorth);
    areaSouth = await node('South', null);

    crewNorth = await createTeam(named('North crew'));
    crewSouth = await createTeam(named('South crew'));
    await grantAreas(crewNorth.id, [blockNorth], 'teams');
    await grantAreas(crewSouth.id, [areaSouth], 'teams');

    const email = uniqueEmail('arealead');
    const lead = await hire('Area Lead', { email, password: TEST_PASSWORD });
    await grantAreas(lead.id, [areaNorth]);

    insider = await hire('Inside The Block');
    await grantAreas(insider.id, [blockNorth]);

    outsider = await hire('Other Town');
    await grantAreas(outsider.id, [areaSouth]);

    unplaced = await hire('No Area At All');
    crewMate = await hire('Crew Mate', { teamId: crewNorth.id });

    const nomadEmail = uniqueEmail('nomad');
    await hire('Nomad', { email: nomadEmail, password: TEST_PASSWORD });

    leadAuth = as(await login(email), data.tenantA.id);
    nomadAuth = as(await login(nomadEmail), data.tenantA.id);
  });

  afterAll(async () => {
    await db.delete(rolePermissions).where(and(
      eq(rolePermissions.roleId, SYSTEM_ROLES.STAFF),
      inArray(rolePermissions.permissionKey, [...AREA_KEYS]),
    ));
    app.access.invalidate();
  });

  const roster = async (query = '') =>
    bodyOf<List<Staff>>(await app.inject({ method: 'GET', url: `/api/v1/staff?limit=100${query}`, headers: leadAuth }))
      .items
      .map(person => person.id);

  it('reaches a member granted a node below the area, not only the area itself', async () => {
    expect(await roster()).toContain(insider.id);
  });

  it('reaches a member through their crew\'s patch, with no grant of their own', async () => {
    expect(await roster()).toContain(crewMate.id);
  });

  it('leaves out another area\'s member, and anyone placed nowhere', async () => {
    const visible = await roster();

    expect(visible).not.toContain(outsider.id);
    expect(visible).not.toContain(unplaced.id);
  });

  it('answers "who serves this address" within the grant', async () => {
    const serving = await roster(`&locationId=${blockNorth}`);

    expect(serving).toEqual(expect.arrayContaining([insider.id, crewMate.id]));
    expect(serving).not.toContain(outsider.id);
  });

  it('answers 404 for a membership outside the area, never a distinct code', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/staff/${outsider.id}`, headers: leadAuth });

    expect(response.statusCode).toBe(404);
    expect(bodyOf<{ code: string }>(response).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('lists the crews whose patch falls in the area, and no others', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/teams?limit=100', headers: leadAuth });

    expect(response.statusCode, response.body).toBe(200);
    const ids = bodyOf<List<Team>>(response).items.map(team => team.id);
    expect(ids).toContain(crewNorth.id);
    expect(ids).not.toContain(crewSouth.id);
  });

  it('answers 404 for a crew working another area', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/teams/${crewSouth.id}`, headers: leadAuth });

    expect(response.statusCode).toBe(404);
  });

  it('will not hand out an area it does not hold', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${insider.id}/locations`,
      headers: leadAuth,
      payload: { locationIds: [areaSouth] },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(bodyOf<{ code: string }>(response).code).toBe('PERM_SCOPE_DENIED');
  });

  it('cannot edit someone it cannot see, so it cannot grant them in either', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${unplaced.id}/locations`,
      headers: leadAuth,
      payload: { locationIds: [blockNorth] },
    });

    expect(response.statusCode).toBe(404);
  });

  it('hands out an area it does hold, to someone already within reach', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/staff/${insider.id}/locations`,
      headers: leadAuth,
      payload: { locationIds: [areaNorth] },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<Staff>(response).locations.map(area => area.id)).toEqual([areaNorth]);
  });

  it('reaches nobody at all when it holds no area, rather than everybody', async () => {
    const people = await app.inject({ method: 'GET', url: '/api/v1/staff?limit=100', headers: nomadAuth });
    const crews = await app.inject({ method: 'GET', url: '/api/v1/teams?limit=100', headers: nomadAuth });

    expect(people.statusCode, people.body).toBe(200);
    expect(bodyOf<List<Staff>>(people)).toMatchObject({ items: [], total: 0 });
    expect(crews.statusCode, crews.body).toBe(200);
    expect(bodyOf<List<Team>>(crews).items).toEqual([]);
  });
});

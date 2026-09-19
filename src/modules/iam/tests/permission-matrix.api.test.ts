import type { BuiltApp } from '@/app';
import type { SystemRoleId } from '@/config/constants';
import type { PermissionKey } from '@/security/permissions';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import {
  customers,
  locationCategories,
  locations,
  locationSchemas,
  membershipLocations,
  rolePermissions,
  tenantMemberships,
  users,
} from '@/db/schema';
import { hashPassword } from '@/security/password';
import { SYSTEM_ROLE_GRANTS } from '@/security/role-grants';
import { createTestDb } from '@/test/db';
import { seedAuthData, snapshotRoleGrants, TEST_PASSWORD, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { as, signIn } from '@/test/http';

const { db, close } = createTestDb();
const unique = () => randomUUID().slice(0, 8);

let app: BuiltApp;
let cleanup: () => Promise<void>;
let tenantId: string;
let restoreGrants: () => Promise<void>;

const auth: Partial<Record<SystemRoleId, Record<string, string>>> = {};
let suspendedAuth: Record<string, string>;
const createdUserIds: string[] = [];

/**
 * Every route the app serves, with the permission its guard demands.
 *
 * Built from the live route table rather than a hand-written list, so a route
 * added tomorrow is covered by this file the moment it exists.
 */
interface Route { method: string; url: string; permission: PermissionKey | undefined }

let routes: Route[] = [];

function codeOf(response: { statusCode: number; json: () => unknown }): string | undefined {
  if (response.statusCode !== 403)
    return undefined;

  return (response.json() as { code?: string }).code;
}

/**
 * Holding the key must never be refused by the guard — the service may still
 * refuse on scope, which carries a different code. Lacking it must never reach
 * the handler.
 */
function verdict(
  roleId: SystemRoleId,
  route: Route & { permission: PermissionKey },
  status: number,
  code: string | undefined,
): string[] {
  const name = `${route.method} ${route.url} (${route.permission}) -> ${status} ${code ?? ''}`;
  const allowed = holds(roleId, route.permission);

  if (allowed && status === 403 && code === 'PERM_DENIED')
    return [`GRANTED BUT BLOCKED: ${name}`];

  if (!allowed && status >= 200 && status < 300)
    return [`NOT GRANTED BUT SERVED: ${name}`];

  return [];
}

/** A path that parses but matches nothing, so we reach the guard and stop there. */
function concreteUrl(url: string): string {
  return url.replaceAll(/:\w+/g, () => randomUUID());
}

function holds(roleId: SystemRoleId, permission: PermissionKey): boolean {
  return SYSTEM_ROLE_GRANTS[roleId].some(([key]) => key === permission);
}

async function member(roleId: SystemRoleId, prefix: string): Promise<{ userId: string; membershipId: string; headers: Record<string, string> }> {
  const email = uniqueEmail(prefix);
  const [user] = await db.insert(users).values({
    email,
    phone: uniquePhone(),
    name: prefix,
    passwordHash: await hashPassword(TEST_PASSWORD),
  }).returning();
  createdUserIds.push(user!.id);

  const [membership] = await db.insert(tenantMemberships)
    .values({ userId: user!.id, tenantId, roleId })
    .returning();

  return { userId: user!.id, membershipId: membership!.id, headers: as(await signIn(app, email), tenantId) };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const data = await seedAuthData(db);
  cleanup = data.cleanup;
  tenantId = data.tenantA.id;

  // The shipped grant matrix, not the cut-down fixture one: this file exists to
  // prove what actually ships is enforced. It is put back in afterAll, because
  // the three role rows are shared by every test file.
  restoreGrants = await snapshotRoleGrants(db, Object.keys(SYSTEM_ROLE_GRANTS));
  await db.insert(rolePermissions)
    .values(Object.entries(SYSTEM_ROLE_GRANTS).flatMap(([roleId, grants]) =>
      grants.map(([permissionKey, scope]) => ({ roleId, permissionKey, scope })),
    ))
    .onConflictDoUpdate({
      target: [rolePermissions.roleId, rolePermissions.permissionKey],
      set: { scope: (await import('drizzle-orm')).sql`excluded.scope` },
    });

  routes = app.routeTable
    .flatMap(route => (Array.isArray(route.method) ? route.method : [route.method])
      .map(method => ({ method, url: route.url, permission: route.permission })))
    .filter(route => route.url.startsWith('/api/v1/') && route.method !== 'HEAD' && route.method !== 'OPTIONS');

  const [category] = await db.insert(locationCategories)
    .values({ tenantId, name: 'Area', slug: `area-${unique()}` })
    .returning();
  const [schema] = await db.insert(locationSchemas)
    .values({ tenantId, name: 'Flat', slug: `flat-${unique()}` })
    .returning();
  const [area] = await db.insert(locations)
    .values({ tenantId, schemaId: schema!.id, categoryId: category!.id, name: `Area ${unique()}` })
    .returning();

  const admin = await member(SYSTEM_ROLES.ADMIN, 'matrix-admin');
  const staff = await member(SYSTEM_ROLES.STAFF, 'matrix-staff');
  const subscriber = await member(SYSTEM_ROLES.CUSTOMER, 'matrix-customer');

  await db.insert(membershipLocations).values({ membershipId: staff.membershipId, locationId: area!.id });
  await db.insert(customers).values({
    tenantId,
    userId: subscriber.userId,
    name: 'Matrix Subscriber',
    phone: uniquePhone(),
    customerCode: `MTX${unique().toUpperCase()}`,
  });

  // An admin whose membership was suspended after they signed in: the token is
  // still valid, the membership is not.
  const suspended = await member(SYSTEM_ROLES.ADMIN, 'matrix-suspended');
  suspendedAuth = suspended.headers;
  await db.update(tenantMemberships)
    .set({ status: 'suspended' })
    .where(eq(tenantMemberships.id, suspended.membershipId));

  auth[SYSTEM_ROLES.ADMIN] = admin.headers;
  auth[SYSTEM_ROLES.STAFF] = staff.headers;
  auth[SYSTEM_ROLES.CUSTOMER] = subscriber.headers;
});

afterAll(async () => {
  await app.close();
  await restoreGrants();
  await db.delete(customers).where(inArray(customers.userId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
  await cleanup();
  await close();
});

describe('the route table', () => {
  it('is fully covered by this file', () => {
    expect(routes.length).toBeGreaterThan(80);
  });

  it('guards every mutating route outside auth, files and notifications', () => {
    const OPEN_BY_DESIGN = new Set([
      'POST /api/v1/notifications/token',
    ]);

    const unguarded = routes
      .filter(route => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method))
      .filter(route => route.permission === undefined)
      .map(route => `${route.method} ${route.url}`)
      .filter(name => !name.includes('/auth/') && !name.includes('/files') && !name.includes('/notifications'))
      .filter(name => !OPEN_BY_DESIGN.has(name));

    expect(unguarded).toEqual([]);
  });
});

describe('a membership suspended mid-session', () => {
  it('is refused everywhere, however wide the role was', async () => {
    const served: string[] = [];
    let checked = 0;

    for (const route of routes) {
      if (route.permission === undefined)
        continue;

      checked++;
      const response = await app.inject({
        method: route.method as 'GET',
        url: concreteUrl(route.url),
        headers: { ...suspendedAuth, 'content-type': 'application/json' },
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });

      if (response.statusCode >= 200 && response.statusCode < 300)
        served.push(`${route.method} ${route.url} -> ${response.statusCode}`);
    }

    expect(served).toEqual([]);
    expect(checked).toBeGreaterThan(70);
  });
});

describe.each([SYSTEM_ROLES.ADMIN, SYSTEM_ROLES.STAFF, SYSTEM_ROLES.CUSTOMER])('as %s', (roleId) => {
  it('is refused by the guard on exactly the routes its role does not grant', async () => {
    const wrong: string[] = [];
    let checked = 0;

    for (const route of routes) {
      if (route.permission === undefined)
        continue;

      checked++;
      const response = await app.inject({
        method: route.method as 'GET',
        url: concreteUrl(route.url),
        headers: { ...auth[roleId]!, 'content-type': 'application/json' },
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });

      wrong.push(...verdict(
        roleId,
        { ...route, permission: route.permission },
        response.statusCode,
        codeOf(response),
      ));
    }

    expect(wrong).toEqual([]);
    // A silent skip would make this file pass while testing nothing.
    expect(checked).toBeGreaterThan(70);
  });
});

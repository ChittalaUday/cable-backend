import type { BuiltApp } from '@/app';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import {
  customers,
  equipment,
  itemCatalog,
  locationCategories,
  locations,
  locationSchemas,
  membershipLocations,
  packages,
  rolePermissions,
  serviceProviders,
  services,
  subscriptions,
  tenantMemberships,
  users,
} from '@/db/schema';
import { hashPassword } from '@/security/password';
import { SYSTEM_ROLE_GRANTS } from '@/security/role-grants';
import { createTestDb } from '@/test/db';
import { releaseUserReferences, seedAuthData, snapshotRoleGrants, TEST_PASSWORD, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { as, bodyOf, signIn } from '@/test/http';

const { db, close } = createTestDb();
const unique = () => randomUUID().slice(0, 8);

let app: BuiltApp;
let cleanup: () => Promise<void>;
let restoreGrants: () => Promise<void>;
let tenantId: string;

let engineerAuth: Record<string, string>;
let catalogId: string;

const mine = { locationId: '', customerId: '' };
const theirs = { locationId: '', customerId: '' };

const createdUserIds: string[] = [];

async function issue(customerId: string, headers: Record<string, string>) {
  const serialNumber = `SN-${unique()}`;
  await db.insert(equipment).values({ tenantId, catalogId, serialNumber });

  return app.inject({
    method: 'POST',
    url: '/api/v1/inventory/issue',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: { customerId, catalogId, serialNumber },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const data = await seedAuthData(db);
  cleanup = data.cleanup;
  tenantId = data.tenantA.id;

  // The shipped grants, so this file proves what a real engineer can do.
  restoreGrants = await snapshotRoleGrants(db, [SYSTEM_ROLES.STAFF]);
  await db.insert(rolePermissions)
    .values(SYSTEM_ROLE_GRANTS[SYSTEM_ROLES.STAFF].map(([permissionKey, scope]) => ({
      roleId: SYSTEM_ROLES.STAFF,
      permissionKey,
      scope,
    })))
    .onConflictDoUpdate({
      target: [rolePermissions.roleId, rolePermissions.permissionKey],
      set: { scope: (await import('drizzle-orm')).sql`excluded.scope` },
    });

  const [category] = await db.insert(locationCategories)
    .values({ tenantId, name: 'Area', slug: `area-${unique()}` })
    .returning();
  const [schema] = await db.insert(locationSchemas)
    .values({ tenantId, name: 'Flat', slug: `flat-${unique()}` })
    .returning();

  const node = async (name: string) => {
    const [row] = await db.insert(locations)
      .values({ tenantId, schemaId: schema!.id, categoryId: category!.id, name })
      .returning();
    return row!.id;
  };

  mine.locationId = await node(`Mine ${unique()}`);
  theirs.locationId = await node(`Theirs ${unique()}`);

  const [service] = await db.insert(services)
    .values({ tenantId, name: 'Cable TV', slug: `cable-${unique()}` })
    .returning();
  const [provider] = await db.insert(serviceProviders)
    .values({ tenantId, serviceId: service!.id, name: 'ACT', slug: `act-${unique()}` })
    .returning();
  const [pkg] = await db.insert(packages)
    .values({ tenantId, serviceProviderId: provider!.id, name: `Base ${unique()}`, slug: `base-${unique()}`, price: '300.00' })
    .returning();
  const [catalog] = await db.insert(itemCatalog)
    .values({ tenantId, name: 'Set Top Box', code: `STB-${unique()}` })
    .returning();
  catalogId = catalog!.id;

  const customer = async (name: string, locationId: string) => {
    const [row] = await db.insert(customers)
      .values({ tenantId, name, phone: uniquePhone(), customerCode: `C${unique().toUpperCase()}` })
      .returning();
    await db.insert(subscriptions).values({
      tenantId,
      customerId: row!.id,
      installationLocationId: locationId,
      serviceProviderId: provider!.id,
      packageId: pkg!.id,
      serviceAccountNumber: `SA-${unique()}`,
    });
    return row!.id;
  };

  mine.customerId = await customer('In My Area', mine.locationId);
  theirs.customerId = await customer('Someone Else', theirs.locationId);

  const email = uniqueEmail('engineer');
  const [engineer] = await db.insert(users).values({
    email,
    phone: uniquePhone(),
    name: 'Field Engineer',
    passwordHash: await hashPassword(TEST_PASSWORD),
  }).returning();
  createdUserIds.push(engineer!.id);

  const [membership] = await db.insert(tenantMemberships)
    .values({ userId: engineer!.id, tenantId, roleId: SYSTEM_ROLES.STAFF })
    .returning();
  await db.insert(membershipLocations)
    .values({ membershipId: membership!.id, locationId: mine.locationId });

  engineerAuth = as(await signIn(app, email), tenantId);
});

afterAll(async () => {
  await app.close();
  await restoreGrants();
  await releaseUserReferences(db, createdUserIds);
  await db.delete(users).where(inArray(users.id, createdUserIds));
  await cleanup();
  await close();
});

describe('a field engineer', () => {
  it('can fit a box for a customer in their own area', async () => {
    const response = await issue(mine.customerId, engineerAuth);

    expect(response.statusCode, response.body).toBe(201);
    expect(bodyOf<{ customerId: string }>(response).customerId).toBe(mine.customerId);
  });

  it('cannot fit one for a customer in somebody else\'s area', async () => {
    const response = await issue(theirs.customerId, engineerAuth);

    expect(response.statusCode, response.body).toBe(404);
  });

  it('can collect the box back from their own area', async () => {
    const assignments = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/customer-equipment?customerId=${mine.customerId}`,
      headers: engineerAuth,
    });
    expect(assignments.statusCode, assignments.body).toBe(200);

    const [assignment] = bodyOf<{ id: string }[]>(assignments);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/return',
      headers: { ...engineerAuth, 'content-type': 'application/json' },
      payload: { customerEquipmentId: assignment!.id, returnCondition: 'working' },
    });

    expect(response.statusCode, response.body).toBe(200);
  });
});

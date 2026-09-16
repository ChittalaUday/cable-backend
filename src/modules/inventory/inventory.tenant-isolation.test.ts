import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
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
  stockMovements,
  subscriptions,
  tenantMemberships,
  users,
} from '@/db/schema';
import { hashPassword } from '@/security/password';
import { PERMISSIONS } from '@/security/permissions';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let alpha: Tenant;
let beta: Tenant;
let alphaAuth: Record<string, string>;
let alphaStaffAuth: Record<string, string>;
let alphaStaffUserId: string;

const createdUserIds: string[] = [];

const unique = () => randomUUID().slice(0, 8);

interface Tenant {
  id: string;
  locationId: string;
  catalogId: string;
  customerId: string;
  subscriptionId: string;
  equipmentId: string;
  adminUserId: string;
}

async function makeMember(tenantId: string, prefix: string, roleId: string): Promise<{ id: string; email: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: uniqueEmail(prefix),
      phone: uniquePhone(),
      name: prefix,
      passwordHash: await hashPassword(TEST_PASSWORD),
    })
    .returning();

  await db.insert(tenantMemberships).values({ userId: row!.id, tenantId, roleId });
  createdUserIds.push(row!.id);

  return { id: row!.id, email: row!.email! };
}

async function signIn(email: string): Promise<Record<string, string>> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: email, password: TEST_PASSWORD },
  });
  expect(login.statusCode).toBe(200);

  return { authorization: `Bearer ${bodyOf(login).accessToken}` };
}

async function seedTenant(tenantId: string, prefix: string): Promise<Tenant> {
  const admin = await makeMember(tenantId, prefix, SYSTEM_ROLES.ADMIN);

  const [category] = await db
    .insert(locationCategories)
    .values({ tenantId, name: 'Area', slug: `area-${unique()}` })
    .returning();

  const [locationSchema] = await db
    .insert(locationSchemas)
    .values({ tenantId, name: 'Flat', slug: `flat-${unique()}` })
    .returning();

  const [location] = await db
    .insert(locations)
    .values({
      tenantId,
      schemaId: locationSchema!.id,
      categoryId: category!.id,
      name: `${prefix} Area ${unique()}`,
    })
    .returning();

  const [service] = await db
    .insert(services)
    .values({ tenantId, name: 'Cable TV', slug: `cable-${unique()}` })
    .returning();

  const [provider] = await db
    .insert(serviceProviders)
    .values({ tenantId, serviceId: service!.id, name: 'ACT', slug: `act-${unique()}` })
    .returning();

  const [pkg] = await db
    .insert(packages)
    .values({ tenantId, serviceProviderId: provider!.id, name: 'Gold', slug: `gold-${unique()}`, price: '349.00' })
    .returning();

  const [catalog] = await db
    .insert(itemCatalog)
    .values({ tenantId, name: 'Set-top box', code: `STB-${unique()}` })
    .returning();

  const [customer] = await db
    .insert(customers)
    .values({
      tenantId,
      customerCode: `${prefix.toUpperCase()}-${unique()}`,
      name: `${prefix} Subscriber`,
      phone: uniquePhone(),
    })
    .returning();

  const [subscription] = await db
    .insert(subscriptions)
    .values({
      tenantId,
      customerId: customer!.id,
      serviceProviderId: provider!.id,
      packageId: pkg!.id,
      serviceAccountNumber: `ACC-${unique()}`,
      installationLocationId: location!.id,
    })
    .returning();

  const [unit] = await db
    .insert(equipment)
    .values({
      tenantId,
      catalogId: catalog!.id,
      locationId: location!.id,
      serialNumber: `SN-${unique()}`,
      inventoryStatus: 'available',
    })
    .returning();

  return {
    id: tenantId,
    locationId: location!.id,
    catalogId: catalog!.id,
    customerId: customer!.id,
    subscriptionId: subscription!.id,
    equipmentId: unit!.id,
    adminUserId: admin.id,
  };
}

async function post(url: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, headers: { ...alphaAuth, 'x-tenant-id': alpha.id }, payload });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  alpha = await seedTenant(data.tenantA.id, 'alpha');
  beta = await seedTenant(data.tenantB.id, 'beta');

  alphaAuth = await signIn((await db.select({ email: users.email }).from(users).where(eq(users.id, alpha.adminUserId)))[0]!.email!);

  const staff = await makeMember(alpha.id, 'alpha-staff', SYSTEM_ROLES.STAFF);
  await db
    .insert(rolePermissions)
    .values([
      { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.INVENTORY_VIEW, scope: 'LOCATION' as const },
      { roleId: SYSTEM_ROLES.STAFF, permissionKey: PERMISSIONS.INVENTORY_UPDATE, scope: 'LOCATION' as const },
    ])
    .onConflictDoNothing();
  alphaStaffAuth = await signIn(staff.email);

  const [staffMembership] = await db
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .where(eq(tenantMemberships.userId, staff.id));
  alphaStaffUserId = staff.id;
  await db.insert(membershipLocations).values({
    membershipId: staffMembership!.id,
    locationId: alpha.locationId,
  });
});

afterAll(async () => {
  await app.close();
  await db.delete(users).where(inArray(users.id, createdUserIds));
  await data.cleanup();
  await close();
});

describe('inventory tenant isolation', () => {
  it('refuses to issue another tenant\'s equipment', async () => {
    const response = await post('/api/v1/inventory/issue', {
      customerId: alpha.customerId,
      catalogId: alpha.catalogId,
      equipmentId: beta.equipmentId,
    });

    expect(response.statusCode).toBe(404);

    const [unit] = await db.select().from(equipment).where(eq(equipment.id, beta.equipmentId));
    expect(unit!.tenantId).toBe(beta.id);
    expect(unit!.inventoryStatus).toBe('available');
    expect(unit!.locationId).toBe(beta.locationId);
  });

  it('refuses to hang an issue off another tenant\'s subscription', async () => {
    const response = await post('/api/v1/inventory/issue', {
      customerId: alpha.customerId,
      catalogId: alpha.catalogId,
      equipmentId: alpha.equipmentId,
      subscriptionId: beta.subscriptionId,
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a subscription belonging to a different customer of the same tenant', async () => {
    const [other] = await db
      .insert(customers)
      .values({ tenantId: alpha.id, name: 'Someone else', phone: uniquePhone() })
      .returning();

    const response = await post('/api/v1/inventory/issue', {
      customerId: other!.id,
      catalogId: alpha.catalogId,
      equipmentId: alpha.equipmentId,
      subscriptionId: alpha.subscriptionId,
    });

    expect(response.statusCode).toBe(404);

    await db.delete(customers).where(eq(customers.id, other!.id));
  });

  it('refuses to book stock in at another tenant\'s location', async () => {
    const response = await post('/api/v1/inventory/inward', {
      catalogId: alpha.catalogId,
      locationId: beta.locationId,
      quantity: 1,
    });

    expect(response.statusCode).toBe(404);

    const stranded = await db
      .select({ id: equipment.id })
      .from(equipment)
      .where(eq(equipment.locationId, beta.locationId));

    expect(stranded.map(row => row.id)).toEqual([beta.equipmentId]);
  });

  it('refuses to transfer stock to another tenant\'s location', async () => {
    const response = await post('/api/v1/inventory/transfer', {
      equipmentId: alpha.equipmentId,
      toLocationId: beta.locationId,
    });

    expect(response.statusCode).toBe(404);

    const [unit] = await db.select().from(equipment).where(eq(equipment.id, alpha.equipmentId));
    expect(unit!.locationId).toBe(alpha.locationId);
  });

  it('refuses to transfer stock to another tenant\'s staff', async () => {
    const response = await post('/api/v1/inventory/transfer', {
      equipmentId: alpha.equipmentId,
      toStaffId: beta.adminUserId,
    });

    expect(response.statusCode).toBe(404);

    const [unit] = await db.select().from(equipment).where(eq(equipment.id, alpha.equipmentId));
    expect(unit!.staffId).toBeNull();
  });

  it('transfers within the tenant, and records it', async () => {
    const [source] = await db.select().from(locations).where(eq(locations.id, alpha.locationId));

    const [target] = await db
      .insert(locations)
      .values({
        tenantId: alpha.id,
        schemaId: source!.schemaId,
        categoryId: source!.categoryId,
        name: `Alpha Depot ${unique()}`,
      })
      .returning();

    try {
      const response = await post('/api/v1/inventory/transfer', {
        equipmentId: alpha.equipmentId,
        toLocationId: target!.id,
      });

      expect(response.statusCode).toBe(201);

      const [unit] = await db.select().from(equipment).where(eq(equipment.id, alpha.equipmentId));
      expect(unit!.locationId).toBe(target!.id);

      const movements = await db
        .select()
        .from(stockMovements)
        .where(eq(stockMovements.equipmentId, alpha.equipmentId));

      expect(movements).toHaveLength(1);
      expect(movements[0]!.toLocationId).toBe(target!.id);
    }
    finally {
      await db.update(equipment).set({ locationId: alpha.locationId }).where(eq(equipment.id, alpha.equipmentId));
      await db.delete(stockMovements).where(eq(stockMovements.equipmentId, alpha.equipmentId));
      await db.delete(locations).where(eq(locations.id, target!.id));
    }
  });

  it('rolls the equipment back when the movement cannot be written', async () => {
    await db.execute(sql`
      ALTER TABLE inventory.stock_movements
      ADD CONSTRAINT stock_movements_rollback_probe CHECK (notes IS DISTINCT FROM 'rollback-probe')
    `);

    try {
      const response = await post('/api/v1/inventory/transfer', {
        equipmentId: alpha.equipmentId,
        toStaffId: alpha.adminUserId,
        notes: 'rollback-probe',
      });

      expect(response.statusCode).toBe(500);

      const [unit] = await db.select().from(equipment).where(eq(equipment.id, alpha.equipmentId));
      expect(unit!.staffId).toBeNull();
      expect(unit!.inventoryStatus).toBe('available');
      expect(unit!.locationId).toBe(alpha.locationId);
    }
    finally {
      await db.execute(sql`
        ALTER TABLE inventory.stock_movements DROP CONSTRAINT stock_movements_rollback_probe
      `);
    }
  });
});

describe('inventory catalog permission', () => {
  const item = () => ({ name: `Router ${unique()}`, code: `RTR-${unique()}` });

  it('lets a holder of inventory.manage_catalog write the catalogue', async () => {
    const response = await post('/api/v1/inventory/items', item());

    expect(response.statusCode, response.body).toBe(201);
  });

  it('refuses staff, who hold inventory.update but not manage_catalog', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/items',
      headers: { ...alphaStaffAuth, 'x-tenant-id': alpha.id },
      payload: item(),
    });

    expect(response.statusCode).toBe(403);
    expect(bodyOf<{ code: string }>(response).code).toBe('PERM_DENIED');
  });

  it('shows staff only their own change requests', async () => {
    const mine = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/requests',
      headers: { ...alphaStaffAuth, 'x-tenant-id': alpha.id },
      payload: { requestType: 'create_item', proposedData: item(), reason: 'Missing from the catalogue' },
    });
    expect(mine.statusCode, mine.body).toBe(201);

    const theirs = await post('/api/v1/inventory/requests', { requestType: 'create_item', proposedData: item(), reason: 'Reviewer\'s own proposal' });
    expect(theirs.statusCode, theirs.body).toBe(201);

    const staffList = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/requests',
      headers: { ...alphaStaffAuth, 'x-tenant-id': alpha.id },
    });
    const reviewerList = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/requests',
      headers: { ...alphaAuth, 'x-tenant-id': alpha.id },
    });

    const staffSees = bodyOf<{ id: string }[]>(staffList);
    const reviewerSees = bodyOf<{ id: string }[]>(reviewerList);

    expect(staffSees).toHaveLength(1);
    expect(reviewerSees.length).toBeGreaterThanOrEqual(2);
  });
});

describe('inventory location scope', () => {
  const asStaff = async (url: string) =>
    app.inject({ method: 'GET', url, headers: { ...alphaStaffAuth, 'x-tenant-id': alpha.id } });

  let depotId: string;
  let depotUnitSerial: string;

  beforeAll(async () => {
    const [source] = await db.select().from(locations).where(eq(locations.id, alpha.locationId));

    const [depot] = await db
      .insert(locations)
      .values({
        tenantId: alpha.id,
        schemaId: source!.schemaId,
        categoryId: source!.categoryId,
        name: `Alpha Depot ${unique()}`,
      })
      .returning();
    depotId = depot!.id;

    depotUnitSerial = `SN-DEPOT-${unique()}`;
    await db.insert(equipment).values({
      tenantId: alpha.id,
      catalogId: alpha.catalogId,
      locationId: depotId,
      serialNumber: depotUnitSerial,
      inventoryStatus: 'available',
    });
  });

  it('sees stock inside a granted area', async () => {
    const response = await asStaff('/api/v1/inventory/stock');

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<{ totalStock: number }[]>(response).reduce((sum, row) => sum + row.totalStock, 0)).toBe(1);
  });

  it('does not see stock in an area it was not granted', async () => {
    const response = await asStaff(`/api/v1/inventory/lookup?q=${depotUnitSerial}`);

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<{ serialNumber: string | null }[]>(response)
      .map(row => row.serialNumber))
      .not
      .toContain(depotUnitSerial);
  });

  it('an admin at ALL still sees every unit', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/lookup?q=${depotUnitSerial}`,
      headers: { ...alphaAuth, 'x-tenant-id': alpha.id },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(bodyOf<{ serialNumber: string | null }[]>(response)
      .map(row => row.serialNumber))
      .toContain(depotUnitSerial);
  });

  it('sees its own van stock, which has no location', async () => {
    const vanSerial = `SN-VAN-${unique()}`;
    const [vanUnit] = await db.insert(equipment).values({
      tenantId: alpha.id,
      catalogId: alpha.catalogId,
      locationId: null,
      staffId: alphaStaffUserId,
      serialNumber: vanSerial,
      inventoryStatus: 'staff_van',
    }).returning();

    try {
      const response = await asStaff(`/api/v1/inventory/lookup?q=${vanSerial}`);

      expect(response.statusCode, response.body).toBe(200);
      expect(bodyOf<{ serialNumber: string | null }[]>(response)
        .map(row => row.serialNumber))
        .toContain(vanSerial);
    }
    finally {
      await db.delete(equipment).where(eq(equipment.id, vanUnit!.id));
    }
  });

  it('does not see another technician\'s van stock', async () => {
    const otherSerial = `SN-OTHERVAN-${unique()}`;
    const [otherUnit] = await db.insert(equipment).values({
      tenantId: alpha.id,
      catalogId: alpha.catalogId,
      locationId: null,
      staffId: alpha.adminUserId,
      serialNumber: otherSerial,
      inventoryStatus: 'staff_van',
    }).returning();

    try {
      const response = await asStaff(`/api/v1/inventory/lookup?q=${otherSerial}`);

      expect(response.statusCode, response.body).toBe(200);
      expect(bodyOf<{ serialNumber: string | null }[]>(response)
        .map(row => row.serialNumber))
        .not
        .toContain(otherSerial);
    }
    finally {
      await db.delete(equipment).where(eq(equipment.id, otherUnit!.id));
    }
  });
});

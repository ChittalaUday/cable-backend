import process from 'node:process';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import * as schema from '@/db/schema';
import {
  equipment,
  itemCatalog,
  locationCategories,
  locations,
  locationSchemas,
  stockMovements,
  tenants,
  users,
} from '@/db/schema';

async function main() {
  const client = new pg.Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(client, { schema });

  console.log('Seeding inventory data...');

  const allTenants = await db.select().from(tenants);
  if (allTenants.length === 0) {
    console.error('No tenant found. Run main seeder first.');
    process.exit(1);
  }

  for (const tenant of allTenants) {
    console.log(`Seeding inventory for tenant: ${tenant.name} (${tenant.id})`);

    const [adminUser] = await db.select().from(users).limit(1);

    let [areaCategory] = await db
      .select()
      .from(locationCategories)
      .where(and(eq(locationCategories.tenantId, tenant.id), eq(locationCategories.slug, 'area')))
      .limit(1);

    if (!areaCategory) {
      [areaCategory] = await db
        .insert(locationCategories)
        .values({
          tenantId: tenant.id,
          name: 'Area',
          slug: 'area',
          config: {},
        })
        .returning();
    }

    let [streetSchema] = await db
      .select()
      .from(locationSchemas)
      .where(and(eq(locationSchemas.tenantId, tenant.id), eq(locationSchemas.slug, 'street-address')))
      .limit(1);

    if (!streetSchema) {
      [streetSchema] = await db
        .insert(locationSchemas)
        .values({
          tenantId: tenant.id,
          name: 'Street Address',
          slug: 'street-address',
        })
        .returning();
    }

    let [centralWarehouse] = await db
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tenant.id), eq(locations.name, 'Central Warehouse')))
      .limit(1);

    if (!centralWarehouse && areaCategory && streetSchema) {
      [centralWarehouse] = await db
        .insert(locations)
        .values({
          tenantId: tenant.id,
          name: 'Central Warehouse',
          code: 'WH-CENTRAL',
          categoryId: areaCategory.id,
          schemaId: streetSchema.id,
          parentId: null,
        })
        .returning();
    }

    let [kphbBranch] = await db
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tenant.id), eq(locations.name, 'KPHB Branch')))
      .limit(1);

    if (!kphbBranch && areaCategory && streetSchema) {
      [kphbBranch] = await db
        .insert(locations)
        .values({
          tenantId: tenant.id,
          name: 'KPHB Branch',
          code: 'BR-KPHB',
          categoryId: areaCategory.id,
          schemaId: streetSchema.id,
          parentId: null,
        })
        .returning();
    }

    const warehouse = centralWarehouse ?? (await db.select().from(locations).where(eq(locations.tenantId, tenant.id)).limit(1))[0];
    const branch = kphbBranch ?? warehouse;

    const itemsToCreate = [
      {
        name: 'ACT HD STB',
        code: 'STB-001',
        brand: 'ACT',
        model: 'HD-2024',
        isSerialized: true,
        isBundle: false,
        defaultSalePrice: '1500.00',
        defaultDepositAmount: '500.00',
        description: 'ACT HD Set Top Box with HEVC support. Includes remote, adapter and user manual in kit.',
        totalQty: 120,
        availQty: 120,
      },
      {
        name: 'Universal Remote',
        code: 'REM-001',
        brand: 'ACT',
        model: 'REM-V2',
        isSerialized: false,
        isBundle: false,
        defaultSalePrice: '250.00',
        defaultDepositAmount: '0.00',
        description: 'Universal replacement remote control compatible with all ACT STB models.',
        totalQty: 85,
        availQty: 5,
      },
      {
        name: 'Power Adapter 12V',
        code: 'PWR-001',
        brand: 'Huntkey',
        model: '12V 1.5A',
        isSerialized: false,
        isBundle: false,
        defaultSalePrice: '300.00',
        defaultDepositAmount: '0.00',
        description: '12V 1.5A DC regulated power adapter with surge protection.',
        totalQty: 200,
        availQty: 8,
      },
      {
        name: 'HDMI Cable',
        code: 'CAB-001',
        brand: 'HighSpeed',
        model: '1.5m 4K',
        isSerialized: false,
        isBundle: false,
        defaultSalePrice: '150.00',
        defaultDepositAmount: '0.00',
        description: 'High-speed HDMI 2.0 cable with gold plated connectors.',
        totalQty: 150,
        availQty: 150,
      },
      {
        name: 'Fiber Mini Node',
        code: 'NODE-001',
        brand: 'OptiLink',
        model: 'FN-100',
        isSerialized: true,
        isBundle: false,
        defaultSalePrice: '850.00',
        defaultDepositAmount: '200.00',
        description: 'FTTH optical receiver mini node with RF output for CATV.',
        totalQty: 25,
        availQty: 25,
      },
      {
        name: 'Patch Cord 3m',
        code: 'PATCH-003',
        brand: 'D-Link',
        model: 'SC-APC 3m',
        isSerialized: false,
        isBundle: false,
        defaultSalePrice: '120.00',
        defaultDepositAmount: '0.00',
        description: 'Single-mode Simplex SC/APC to SC/APC fiber patch cord 3 meters.',
        totalQty: 60,
        availQty: 60,
      },
      {
        name: 'STB Kit (Bundle)',
        code: 'KIT-001',
        brand: 'ACT',
        model: 'STB-Bundle-HD',
        isSerialized: true,
        isBundle: true,
        defaultSalePrice: '2000.00',
        defaultDepositAmount: '500.00',
        description: 'Complete subscriber installation kit: STB + Remote + Power Adapter + HDMI Cable.',
        totalQty: 40,
        availQty: 40,
      },
    ];

    const createdCatalogMap = new Map<string, string>();

    for (const item of itemsToCreate) {
      let [existing] = await db
        .select()
        .from(itemCatalog)
        .where(eq(itemCatalog.code, item.code));

      if (!existing) {
        const [inserted] = await db
          .insert(itemCatalog)
          .values({
            tenantId: tenant.id,
            name: item.name,
            code: item.code,
            brand: item.brand,
            model: item.model,
            isBundle: item.isBundle,
            defaultSalePrice: item.defaultSalePrice,
            defaultDepositAmount: item.defaultDepositAmount,
            description: item.description,
          })
          .returning();
        existing = inserted;
      }

      createdCatalogMap.set(item.code, existing!.id);

      const existingEq = await db
        .select()
        .from(equipment)
        .where(eq(equipment.catalogId, existing!.id));

      if (existingEq.length === 0) {
        const unit = (index: number, status: 'available' | 'allocated') => ({
          tenantId: tenant.id,
          catalogId: existing!.id,
          locationId: warehouse?.id ?? null,
          inventoryStatus: status,
          ...(item.isSerialized && index <= 3
            ? {
                serialNumber: `${item.code}-SN${1000 + index}`,
                vcNumber: `VC${987600 + index}`,
                macAddress: `00:1A:2B:3C:4D:0${index}`,
                barcode: `${item.code}000${index}`,
              }
            : {}),
        });

        const units = [
          ...Array.from({ length: item.availQty }, (_, i) => unit(i + 1, 'available')),
          ...Array.from({ length: Math.max(0, item.totalQty - item.availQty) }, (_, i) => unit(item.availQty + i + 1, 'allocated')),
        ];

        if (units.length > 0)
          await db.insert(equipment).values(units);
      }
    }
    const [anyEq] = await db.select().from(equipment).limit(1);
    if (anyEq && adminUser) {
      const existingMovs = await db.select().from(stockMovements).where(eq(stockMovements.tenantId, tenant.id));
      if (existingMovs.length === 0) {
        await db.insert(stockMovements).values([
          {
            tenantId: tenant.id,
            equipmentId: anyEq.id,
            movementType: 'customer_issue',
            fromLocationId: warehouse?.id ?? null,
            toLocationId: branch?.id ?? null,
            performedBy: adminUser.id,
            notes: 'STB-001 to Rajesh Kumar',
            createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
          {
            tenantId: tenant.id,
            equipmentId: anyEq.id,
            movementType: 'inward',
            fromLocationId: null,
            toLocationId: warehouse?.id ?? null,
            performedBy: adminUser.id,
            notes: 'Adapter - 50 units inwarded',
            createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
          },
          {
            tenantId: tenant.id,
            equipmentId: anyEq.id,
            movementType: 'transfer',
            fromLocationId: warehouse?.id ?? null,
            toLocationId: branch?.id ?? null,
            performedBy: adminUser.id,
            notes: 'Remotes transferred to KPHB Branch',
            createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
          },
        ]);
      }

      if (warehouse) {
        await db.execute(sql`
        UPDATE inventory.equipment
        SET location_id = ${warehouse.id}
        WHERE location_id IS NULL AND tenant_id = ${tenant.id};
      `);
      }
    }
  }

  console.log('✅ Inventory data seeded successfully!');
  await client.end();
}

main().catch((err) => {
  console.error('Seeding inventory failed:', err);
  process.exit(1);
});

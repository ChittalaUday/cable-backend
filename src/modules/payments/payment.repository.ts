import type { SQL } from 'drizzle-orm';
import type { CollectionResponse, ListCollectionsQuery } from './payment.schema';
import type { Database, Transaction } from '@/db/client';
import type {
  Collection,
  CollectionAccessory,
  CustomerEquipment,
  Equipment,
  ItemCatalogRecord,
  NewCollection,
  StockMovementRecord,
} from '@/db/schema';
import type { CollectableLine, LockedCustomer } from '@/modules/customers/customer.repository';
import type { LocationScope } from '@/security/location-scope';
import { and, eq, sql } from 'drizzle-orm';
import {
  accountTransactions,
  collections,
  customerEquipment,
  equipment,
  itemCatalog,
  pointOf,
  stockMovements,
} from '@/db/schema';
import { CustomerRepository } from '@/modules/customers/customer.repository';
import { underAnyGrant, withinGrantedSubtree } from '@/security/location-scope';

export interface Takings extends Record<string, unknown> {
  duesPaid: string;
  accessoryAmount: string;
  totalCollected: string;
  receipts: number;
}

export interface HydratedRow extends Record<string, unknown> {
  id: string;
  customerId: string;
  customerName: string | null;
  customerCode: string | null;
  subscriptionId: string | null;
  customerEquipmentId: string | null;
  equipmentName: string | null;
  equipmentItemCode: string | null;
  equipmentSerialNumber: string | null;
  equipmentBrand: string | null;
  equipmentModel: string | null;
  serviceAccountNumber: string | null;
  locationId: string | null;
  locationPath: string | null;
  collectedBy: string;
  collectorName: string | null;
  outcome: CollectionResponse['outcome'];
  method: CollectionResponse['method'];
  dueAmount: string;
  duesPaid: string;
  accessoryAmount: string;
  totalCollected: string;
  balanceAfter: string;
  accessories: CollectionAccessory[] | null;
  reversesId: string | null;
  reversedById: string | null;
  reason: string | null;
  notes: string | null;
  reference: string;
  latitude: string | null;
  longitude: string | null;
  gpsAccuracyM: string | null;
  collectedAt: Date | string;
}

export class PaymentRepository {
  private readonly customers: CustomerRepository;

  constructor(private readonly db: Database) {
    this.customers = new CustomerRepository(db);
  }

  get database(): Database {
    return this.db;
  }

  async inTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  // --- Reach ---------------------------------------------------------------

  /** `null` means the caller can reach nothing; `true` means everything. */
  reachCondition(scope: 'OWN' | 'ALL' | LocationScope, userId: string): SQL | null {
    if (scope === 'OWN') {
      return sql`EXISTS (
        SELECT 1 FROM crm.customers own
        WHERE own.id = c.customer_id AND own.user_id = ${userId}
      )`;
    }

    if (scope === 'ALL' || scope.kind === 'ALL_TENANT_LOCATIONS')
      return sql`true`;

    if (scope.nodeIds.length === 0)
      return null;

    return withinGrantedSubtree(sql`s.installation_location_id`, scope.nodeIds);
  }

  async nodeUnderGrant(tx: Transaction, locationId: string, nodeIds: readonly string[]): Promise<boolean> {
    const { rows } = await tx.execute<{ reached: boolean }>(sql`
      SELECT ${underAnyGrant(sql`${locationId}::uuid`, nodeIds)} AS reached
    `);

    return rows[0]?.reached === true;
  }

  // --- Reads ---------------------------------------------------------------

  private selectCollections(): SQL {
    return sql`
      SELECT c.id,
             c.customer_id "customerId",
             coalesce(u.name, cust.name) "customerName",
             cust.customer_code "customerCode",
             c.subscription_id "subscriptionId",
             c.customer_equipment_id "customerEquipmentId",
             ic.name "equipmentName",
             ic.code "equipmentItemCode",
             eq.serial_number "equipmentSerialNumber",
             ic.brand "equipmentBrand",
             ic.model "equipmentModel",
             s.service_account_number "serviceAccountNumber",
             s.installation_location_id "locationId",
             lp.path "locationPath",
             c.collected_by "collectedBy",
             collector.name "collectorName",
             c.outcome, c.method,
             c.due_amount "dueAmount",
             c.dues_paid "duesPaid",
             c.accessory_amount "accessoryAmount",
             c.total_collected "totalCollected",
             c.balance_after "balanceAfter",
             c.accessories,
             c.reverses_id "reversesId",
             (SELECT r.id FROM billing.collections r WHERE r.reverses_id = c.id) "reversedById",
             c.reason, c.notes, c.reference,
             c.latitude, c.longitude, c.gps_accuracy_m "gpsAccuracyM",
             c.collected_at "collectedAt"
      FROM billing.collections c
      JOIN crm.customers cust ON cust.id = c.customer_id
      LEFT JOIN auth.users u ON u.id = cust.user_id
      LEFT JOIN auth.users collector ON collector.id = c.collected_by
      LEFT JOIN crm.subscriptions s ON s.id = c.subscription_id
      LEFT JOIN geo.location_paths lp ON lp.id = s.installation_location_id
      LEFT JOIN inventory.customer_equipment ce ON ce.id = c.customer_equipment_id
      LEFT JOIN inventory.equipment eq ON eq.id = ce.equipment_id
      LEFT JOIN inventory.item_catalog ic ON ic.id = eq.catalog_id
    `;
  }

  async findHydrated(tenantId: string, id: string, reach?: SQL): Promise<HydratedRow | null> {
    const { rows } = await this.db.execute<HydratedRow>(sql`
      ${this.selectCollections()}
      WHERE c.tenant_id = ${tenantId} AND c.id = ${id}
      ${reach === undefined ? sql`` : sql`AND ${reach}`}
    `);

    return rows[0] ?? null;
  }

  async listHydrated(
    tenantId: string,
    userId: string,
    query: ListCollectionsQuery,
    reach: SQL,
    cursor: { collectedAt: Date; id: string } | null,
  ): Promise<{ rows: HydratedRow[]; totals: Takings | undefined }> {
    const limit = query.limit;
    const where = sql.join(this.filtersFor(tenantId, userId, query, reach), sql` AND `);
    const paged = cursor === null ? where : sql`${where} AND ${this.afterCursor(cursor.collectedAt, cursor.id)}`;

    const [page, totals] = await Promise.all([
      this.db.execute<HydratedRow>(sql`
        ${this.selectCollections()}
        WHERE ${paged}
        ORDER BY c.collected_at DESC, c.id DESC
        LIMIT ${limit + 1}
      `),
      this.db.execute<Takings>(sql`
        SELECT coalesce(sum(c.dues_paid), 0) "duesPaid",
               coalesce(sum(c.accessory_amount), 0) "accessoryAmount",
               coalesce(sum(c.total_collected), 0) "totalCollected",
               count(*)::int "receipts"
        FROM billing.collections c
        LEFT JOIN crm.subscriptions s ON s.id = c.subscription_id
        WHERE ${where}
      `),
    ]);

    return { rows: page.rows, totals: totals.rows[0] };
  }

  private filtersFor(tenantId: string, userId: string, query: ListCollectionsQuery, reach: SQL): SQL[] {
    const filters: SQL[] = [sql`c.tenant_id = ${tenantId}`, reach];

    if (query.customerId !== undefined)
      filters.push(sql`c.customer_id = ${query.customerId}`);

    if (query.collectedBy !== undefined)
      filters.push(sql`c.collected_by = ${query.collectedBy === 'me' ? userId : query.collectedBy}`);

    if (query.outcome !== undefined)
      filters.push(sql`c.outcome = ${query.outcome}`);

    if (query.from !== undefined)
      filters.push(sql`c.collected_at >= ${new Date(query.from)}`);

    if (query.to !== undefined)
      filters.push(sql`c.collected_at <= ${new Date(query.to)}`);

    if (query.nearLatitude !== undefined && query.nearLongitude !== undefined) {
      filters.push(sql`c.latitude IS NOT NULL AND ST_DWithin(
        ${pointOf(sql`c.longitude`, sql`c.latitude`)},
        ${pointOf(sql`${query.nearLongitude}`, sql`${query.nearLatitude}`)},
        ${query.withinM ?? 200}
      )`);
    }

    if (query.locationId !== undefined) {
      filters.push(sql`EXISTS (
        SELECT 1 FROM geo.location_descendants(${query.locationId}) AS d WHERE d.id = s.installation_location_id
      )`);
    }

    return filters;
  }

  private afterCursor(collectedAt: Date, id: string): SQL {
    return sql`(c.collected_at, c.id) < (${collectedAt}, ${id}::uuid)`;
  }

  async findByReference(tenantId: string, reference: string): Promise<{ id: string; collectedBy: string; requestHash: string | null } | null> {
    const [row] = await this.db
      .select({ id: collections.id, collectedBy: collections.collectedBy, requestHash: collections.requestHash })
      .from(collections)
      .where(and(eq(collections.tenantId, tenantId), eq(collections.reference, reference)))
      .limit(1);

    return row ?? null;
  }

  async findForReversal(tx: Transaction, tenantId: string, id: string): Promise<Collection | null> {
    const [row] = await tx
      .select()
      .from(collections)
      .where(and(eq(collections.id, id), eq(collections.tenantId, tenantId)))
      .limit(1);

    return row ?? null;
  }

  async findReversalOf(tx: Transaction, tenantId: string, id: string): Promise<string | null> {
    const [row] = await tx
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.reversesId, id), eq(collections.tenantId, tenantId)))
      .limit(1);

    return row?.id ?? null;
  }

  /** Catalogue names for the accessories a collector says they sold. */
  async accessoryNames(tx: Transaction, tenantId: string, catalogIds: readonly string[]): Promise<Map<string, string>> {
    const { rows } = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM inventory.item_catalog
      WHERE tenant_id = ${tenantId} AND id = ANY(${sql.param([...catalogIds])}::uuid[])
        AND deleted_at IS NULL
    `);

    return new Map(rows.map(row => [row.id, row.name]));
  }

  // --- Writes --------------------------------------------------------------

  // `billing.collections` is append-only at the database (trigger
  // `collections_append_only`): there is insert, and nothing else. A mistake is
  // corrected by inserting a reversal that points back at the original.
  async insertCollection(tx: Transaction, values: NewCollection): Promise<Collection> {
    const [row] = await tx.insert(collections).values(values).returning();
    return row!;
  }

  async insertTransaction(tx: Transaction, values: typeof accountTransactions.$inferInsert): Promise<string> {
    const [row] = await tx.insert(accountTransactions).values(values).returning({ id: accountTransactions.id });
    return row!.id;
  }

  // `crm.customers` and `crm.subscriptions` belong to the customers module, so
  // the balance a collector settles is reached through its repository rather
  // than written from here.
  async lockCustomer(tx: Transaction, tenantId: string, customerId: string): Promise<LockedCustomer | null> {
    return this.customers.lockCustomer(tx, tenantId, customerId);
  }

  async collectableLines(tx: Transaction, tenantId: string, customerId: string, subscriptionId: string | null): Promise<CollectableLine[]> {
    return this.customers.collectableLines(tx, tenantId, customerId, subscriptionId);
  }

  async applyDuesPayment(tx: Transaction, tenantId: string, customerId: string, subscriptionId: string, amount: string): Promise<void> {
    return this.customers.applyDuesPayment(tx, tenantId, customerId, subscriptionId, amount);
  }

  // --- Inventory & Customer Equipment ---------------------------------------

  async findCustomerEquipment(tx: Transaction, tenantId: string, id: string): Promise<CustomerEquipment | null> {
    const [row] = await tx
      .select()
      .from(customerEquipment)
      .where(and(eq(customerEquipment.id, id), eq(customerEquipment.tenantId, tenantId)))
      .limit(1);

    return row ?? null;
  }

  async findCatalogItem(tx: Transaction, tenantId: string, id: string): Promise<ItemCatalogRecord | null> {
    const [row] = await tx
      .select()
      .from(itemCatalog)
      .where(and(eq(itemCatalog.id, id), eq(itemCatalog.tenantId, tenantId), sql`${itemCatalog.deletedAt} IS NULL`))
      .limit(1);

    return row ?? null;
  }

  async findEquipmentUnit(tx: Transaction, tenantId: string, id: string): Promise<Equipment | null> {
    const [row] = await tx
      .select()
      .from(equipment)
      .where(and(eq(equipment.id, id), eq(equipment.tenantId, tenantId)))
      .limit(1);

    return row ?? null;
  }

  async findEquipmentBySerial(tx: Transaction, tenantId: string, serialNumber: string): Promise<Equipment | null> {
    const [row] = await tx
      .select()
      .from(equipment)
      .where(and(eq(equipment.tenantId, tenantId), eq(equipment.serialNumber, serialNumber)))
      .limit(1);

    return row ?? null;
  }

  async findAvailableUnit(tx: Transaction, tenantId: string, catalogId: string, serialNumber?: string): Promise<Equipment | null> {
    const conditions = [
      eq(equipment.tenantId, tenantId),
      eq(equipment.catalogId, catalogId),
      eq(equipment.inventoryStatus, 'available'),
      sql`not exists (
        select 1 from inventory.customer_equipment active_assignment
        where active_assignment.tenant_id = ${tenantId}
          and active_assignment.equipment_id = ${equipment.id}
          and active_assignment.status in ('active', 'standby')
      )`,
    ];

    if (serialNumber !== undefined)
      conditions.push(eq(equipment.serialNumber, serialNumber));

    const [row] = await tx
      .select()
      .from(equipment)
      .where(and(...conditions))
      .limit(1);

    return row ?? null;
  }

  async createEquipmentUnit(tx: Transaction, values: typeof equipment.$inferInsert): Promise<Equipment> {
    const [row] = await tx.insert(equipment).values(values).returning();
    return row!;
  }

  async updateEquipmentUnit(tx: Transaction, tenantId: string, id: string, values: Partial<typeof equipment.$inferInsert>): Promise<Equipment> {
    const [row] = await tx
      .update(equipment)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(equipment.id, id), eq(equipment.tenantId, tenantId)))
      .returning();

    return row!;
  }

  async createCustomerEquipment(tx: Transaction, values: typeof customerEquipment.$inferInsert): Promise<CustomerEquipment> {
    const [row] = await tx.insert(customerEquipment).values(values).returning();
    return row!;
  }

  async updateCustomerEquipment(
    tx: Transaction,
    tenantId: string,
    id: string,
    values: Partial<typeof customerEquipment.$inferInsert>,
  ): Promise<CustomerEquipment> {
    const [row] = await tx
      .update(customerEquipment)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(customerEquipment.id, id), eq(customerEquipment.tenantId, tenantId)))
      .returning();

    return row!;
  }

  async createStockMovement(tx: Transaction, values: typeof stockMovements.$inferInsert): Promise<StockMovementRecord> {
    const [row] = await tx.insert(stockMovements).values(values).returning();
    return row!;
  }
}

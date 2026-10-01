import type { SQL } from 'drizzle-orm';
import type {
  CustomerEquipmentQuery,
  InwardStockBody,
  ItemDetailsResponse,
  ListStockQuery,
} from './inventory.schema';
import type { CustomerEquipmentStatus } from '@/constants/inventory';
import type { Database, Transaction } from '@/db/client';
import type { StockMovementRecord } from '@/db/schema';
import type { LocationScope } from '@/security/location-scope';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { SUBSCRIPTION_STATUS } from '@/constants/crm';
import { INVENTORY_STATUS, STOCK_MOVEMENT_TYPE } from '@/constants/inventory';
import {
  approvalRequests,
  customerEquipment,
  customers,
  equipment,
  itemCatalog,
  locations,
  packages,
  stockMovements,
  subscriptions,
  tenantMemberships,
  users,
} from '@/db/schema';
import { customerWithinNodes } from '@/modules/customers/customer.service';
import { withinGrantedSubtree } from '@/security/location-scope';

export interface IssuableUnit {
  id: string;
  catalogId: string | null;
  serialNumber: string | null;
  locationId: string | null;
}

const UNIT_COLUMNS = {
  id: equipment.id,
  catalogId: equipment.catalogId,
  serialNumber: equipment.serialNumber,
  locationId: equipment.locationId,
};

const CATALOG_COLUMNS = {
  id: itemCatalog.id,
  name: itemCatalog.name,
  code: itemCatalog.code,
  brand: itemCatalog.brand,
  model: itemCatalog.model,
  itemType: sql<string>`coalesce(${itemCatalog.itemTypeId}::text, 'other')`,
  isBundle: itemCatalog.isBundle,
  defaultOwnership: itemCatalog.defaultOwnership,
  defaultSalePrice: itemCatalog.defaultSalePrice,
  defaultDepositAmount: itemCatalog.defaultDepositAmount,
  defaultRentalPrice: itemCatalog.defaultRentalPrice,
  isReturnable: itemCatalog.isReturnable,
  icon: itemCatalog.icon,
  description: itemCatalog.description,
};

function stockTotals() {
  return {
    totalStock: sql<number>`count(${equipment.id})::int`,
    availableStock: sql<number>`count(*) FILTER (WHERE ${availableUnit()})::int`,
    issuedStock: sql<number>`count(*) FILTER (WHERE ${issuedUnit()})::int`,
  };
}

function activeAssignment() {
  return sql`exists (
    select 1 from inventory.customer_equipment active_assignment
    where active_assignment.tenant_id = ${equipment.tenantId}
      and active_assignment.equipment_id = ${equipment.id}
      and active_assignment.status in ('active', 'standby')
  )`;
}

function availableUnit() {
  return sql`${equipment.inventoryStatus} = ${INVENTORY_STATUS.AVAILABLE} and not ${activeAssignment()}`;
}

function issuedUnit() {
  return sql`${equipment.inventoryStatus} = ${INVENTORY_STATUS.ALLOCATED} or ${activeAssignment()}`;
}

export class InventoryRepository {
  constructor(private readonly db: Database) {}

  /** The audit trail is written by the service but must land on this same executor. */
  get database(): Database {
    return this.db;
  }

  async inTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  // --- Reach ---------------------------------------------------------------

  /**
   * Stock a caller may see: anything under a granted node, plus anything in
   * their own van — a field engineer carries units that belong to no area.
   */
  visibleStock(scope: LocationScope, userId: string): SQL[] {
    if (scope.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [or(
      withinGrantedSubtree(sql`${equipment.locationId}`, scope.nodeIds),
      eq(equipment.staffId, userId),
    )!];
  }

  visibleLocations(scope: LocationScope): SQL[] {
    if (scope.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [withinGrantedSubtree(sql`${locations.id}`, scope.nodeIds)];
  }

  // --- Lookups used as guards ---------------------------------------------

  async isStaffMember(tenantId: string, userId: string): Promise<boolean> {
    const [member] = await this.db
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, userId),
        isNull(tenantMemberships.deletedAt),
      ))
      .limit(1);

    return member !== undefined;
  }

  async findLocationName(tenantId: string, locationId: string): Promise<string | null> {
    const [loc] = await this.db
      .select({ name: locations.name })
      .from(locations)
      .where(and(
        eq(locations.id, locationId),
        eq(locations.tenantId, tenantId),
        isNull(locations.deletedAt),
      ))
      .limit(1);

    return loc?.name ?? null;
  }

  async anyLocationId(tenantId: string): Promise<string | null> {
    const [location] = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), isNull(locations.deletedAt)))
      .limit(1);

    return location?.id ?? null;
  }

  async findCustomer(tenantId: string, customerId: string) {
    const [row] = await this.db
      .select({ id: customers.id, name: customers.name, code: customers.customerCode })
      .from(customers)
      .where(and(
        eq(customers.id, customerId),
        eq(customers.tenantId, tenantId),
        isNull(customers.deletedAt),
      ))
      .limit(1);

    return row ?? null;
  }

  /**
   * True when any line of this customer sits under one of `nodeIds`. A customer
   * is reachable from the area their service is installed in, not from a column
   * on the customer row — they may hold lines in more than one place.
   */
  async customerInReach(tenantId: string, customerId: string, nodeIds: readonly string[]): Promise<boolean> {
    if (nodeIds.length === 0)
      return false;

    const [row] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(
        eq(customers.id, customerId),
        eq(customers.tenantId, tenantId),
        isNull(customers.deletedAt),
        customerWithinNodes(nodeIds, { id: sql`${customers.id}` }),
      ))
      .limit(1);

    return row !== undefined;
  }

  async subscriptionBelongsTo(tenantId: string, customerId: string, subscriptionId: string): Promise<boolean> {
    const [line] = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.customerId, customerId),
        isNull(subscriptions.deletedAt),
      ))
      .limit(1);

    return line !== undefined;
  }

  /** Where a line is installed — the address an issued box physically goes to. */
  async subscriptionLocation(tenantId: string, subscriptionId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ locationId: subscriptions.installationLocationId })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.tenantId, tenantId),
        isNull(subscriptions.deletedAt),
      ))
      .limit(1);

    return row?.locationId ?? null;
  }

  async findAnySubscriptionId(tenantId: string, customerId: string): Promise<string | null> {
    const [sub] = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.customerId, customerId),
        eq(subscriptions.tenantId, tenantId),
        isNull(subscriptions.deletedAt),
      ))
      .limit(1);

    return sub?.id ?? null;
  }

  async findAnyPackage(tenantId: string) {
    const [pkg] = await this.db
      .select({ packageId: packages.id, providerId: packages.serviceProviderId })
      .from(packages)
      .where(and(eq(packages.tenantId, tenantId), isNull(packages.deletedAt)))
      .limit(1);

    return pkg ?? null;
  }

  async createSubscription(data: typeof subscriptions.$inferInsert): Promise<string> {
    const [row] = await this.db
      .insert(subscriptions)
      .values({ ...data, status: data.status ?? SUBSCRIPTION_STATUS.ACTIVE })
      .returning({ id: subscriptions.id });

    return row!.id;
  }

  // --- Catalog -------------------------------------------------------------

  async findCatalogItemById(tenantId: string, id: string) {
    const [item] = await this.db
      .select()
      .from(itemCatalog)
      .where(and(eq(itemCatalog.id, id), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)))
      .limit(1);

    return item ?? null;
  }

  async findCatalogSummary(tenantId: string, id: string) {
    const [row] = await this.db
      .select(CATALOG_COLUMNS)
      .from(itemCatalog)
      .where(and(eq(itemCatalog.id, id), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)))
      .limit(1);

    return row ?? null;
  }

  async createCatalogItem(data: typeof itemCatalog.$inferInsert) {
    const [item] = await this.db.insert(itemCatalog).values(data).returning();
    return item!;
  }

  async updateCatalogItem(tenantId: string, id: string, data: Partial<typeof itemCatalog.$inferInsert>) {
    const [updated] = await this.db
      .update(itemCatalog)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(itemCatalog.id, id), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)))
      .returning();

    return updated ?? null;
  }

  async softDeleteCatalogItem(tenantId: string, id: string) {
    return this.db
      .update(itemCatalog)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(itemCatalog.id, id), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)));
  }

  /** Units of a catalog item that are not retired — a soft delete leaves them dangling. */
  async countLiveUnits(tenantId: string, catalogId: string): Promise<number> {
    const [live] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(equipment)
      .where(and(
        eq(equipment.tenantId, tenantId),
        eq(equipment.catalogId, catalogId),
        sql`${equipment.inventoryStatus} <> ${INVENTORY_STATUS.RETIRED}`,
      ));

    return live?.total ?? 0;
  }

  // --- Dashboard & stock ---------------------------------------------------

  async stockCounts(tenantId: string, reach: SQL[], locationId?: string) {
    const [row] = await this.db
      .select({
        total: sql<number>`count(${equipment.id})::int`,
        inStock: sql<number>`count(*) FILTER (WHERE ${availableUnit()})::int`,
        issued: sql<number>`count(*) FILTER (WHERE ${issuedUnit()})::int`,
        inTransit: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.STAFF_VAN})::int`,
      })
      .from(equipment)
      .where(and(...this.equipmentScope(tenantId, reach, locationId)));

    return row ?? { total: 0, inStock: 0, issued: 0, inTransit: 0 };
  }

  private equipmentScope(tenantId: string, reach: SQL[], locationId?: string): SQL[] {
    const conditions = [eq(equipment.tenantId, tenantId), ...reach];

    if (locationId !== undefined)
      conditions.push(eq(equipment.locationId, locationId));

    return conditions;
  }

  async lowStockItems(tenantId: string, reach: SQL[], locationId: string | undefined, threshold: number, limit: number) {
    return this.db
      .select({
        id: itemCatalog.id,
        name: itemCatalog.name,
        code: itemCatalog.code,
        totalStock: sql<number>`count(${equipment.id})::int`,
        availableStock: sql<number>`count(*) FILTER (WHERE ${availableUnit()})::int`,
      })
      .from(itemCatalog)
      .leftJoin(equipment, and(
        eq(itemCatalog.id, equipment.catalogId),
        ...this.equipmentScope(tenantId, reach, locationId),
      ))
      .where(and(eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)))
      .groupBy(itemCatalog.id, itemCatalog.name, itemCatalog.code)
      .having(sql`count(*) FILTER (WHERE ${availableUnit()}) <= ${threshold}`)
      .limit(limit);
  }

  async recentMovements(tenantId: string, reach: SQL[], limit: number) {
    const locFrom = alias(locations, 'loc_from');
    const locTo = alias(locations, 'loc_to');

    return this.db
      .select({
        id: stockMovements.id,
        movementType: stockMovements.movementType,
        quantity: stockMovements.quantity,
        createdAt: stockMovements.createdAt,
        itemName: sql<string>`coalesce(${itemCatalog.name}, 'Item')`,
        itemCode: itemCatalog.code,
        notes: stockMovements.notes,
        fromLocationName: locFrom.name,
        toLocationName: locTo.name,
        performedByName: sql<string>`coalesce(${users.name}, 'Staff')`,
      })
      .from(stockMovements)
      .innerJoin(equipment, eq(stockMovements.equipmentId, equipment.id))
      .leftJoin(itemCatalog, eq(equipment.catalogId, itemCatalog.id))
      .leftJoin(locFrom, eq(stockMovements.fromLocationId, locFrom.id))
      .leftJoin(locTo, eq(stockMovements.toLocationId, locTo.id))
      .leftJoin(users, eq(stockMovements.performedBy, users.id))
      .where(and(eq(stockMovements.tenantId, tenantId), ...reach))
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit);
  }

  async stockList(tenantId: string, reach: SQL[], query: ListStockQuery) {
    const conditions = [eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)];

    if (query.search !== undefined && query.search !== '') {
      const s = `%${query.search}%`;
      conditions.push(or(
        ilike(itemCatalog.name, s),
        ilike(itemCatalog.code, s),
        ilike(itemCatalog.brand, s),
        ilike(itemCatalog.model, s),
      )!);
    }

    return this.db
      .select({
        ...CATALOG_COLUMNS,
        ...stockTotals(),
        inTransitStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.WITH_STAFF})::int`,
        aggregatedLocationName: sql<string | null>`max(${locations.name})`,
        aggregatedLocationId: sql<string | null>`max(${equipment.locationId}::text)`,
        bundleContents: sql<ItemDetailsResponse['bundleComponents']>`'[]'::jsonb`,
      })
      .from(itemCatalog)
      .leftJoin(equipment, and(
        eq(itemCatalog.id, equipment.catalogId),
        ...this.equipmentScope(tenantId, reach, query.locationId),
      ))
      .leftJoin(locations, and(eq(equipment.locationId, locations.id), isNull(locations.deletedAt)))
      .where(and(...conditions))
      .groupBy(
        itemCatalog.id,
        itemCatalog.name,
        itemCatalog.code,
        itemCatalog.brand,
        itemCatalog.model,
        itemCatalog.itemTypeId,
        itemCatalog.isBundle,
        itemCatalog.defaultOwnership,
        itemCatalog.defaultSalePrice,
        itemCatalog.defaultDepositAmount,
        itemCatalog.defaultRentalPrice,
        itemCatalog.isReturnable,
        itemCatalog.icon,
        itemCatalog.description,
      )
      .orderBy(itemCatalog.name);
  }

  async catalogUnits(tenantId: string, catalogId: string, reach: SQL[], limit: number) {
    return this.db
      .select({
        id: equipment.id,
        serialNumber: equipment.serialNumber,
        vcNumber: equipment.vcNumber,
        macAddress: equipment.macAddress,
        barcode: equipment.barcode,
        inventoryStatus: equipment.inventoryStatus,
        locationId: equipment.locationId,
        locationName: locations.name,
        staffName: users.name,
      })
      .from(equipment)
      .leftJoin(locations, and(eq(equipment.locationId, locations.id), isNull(locations.deletedAt)))
      .leftJoin(users, eq(equipment.staffId, users.id))
      .where(and(eq(equipment.catalogId, catalogId), eq(equipment.tenantId, tenantId), ...reach))
      .limit(limit);
  }

  async catalogTotals(tenantId: string, catalogId: string, reach: SQL[]) {
    const [totals] = await this.db
      .select({
        totalStock: sql<number>`count(*)::int`,
        availableStock: sql<number>`count(*) FILTER (WHERE ${availableUnit()})::int`,
        issuedStock: sql<number>`count(*) FILTER (WHERE ${issuedUnit()})::int`,
        inTransitStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.STAFF_VAN})::int`,
      })
      .from(equipment)
      .where(and(eq(equipment.catalogId, catalogId), eq(equipment.tenantId, tenantId), ...reach));

    return totals ?? { totalStock: 0, availableStock: 0, issuedStock: 0, inTransitStock: 0 };
  }

  // --- Equipment units -----------------------------------------------------

  async findUnitById(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(equipment)
      .where(and(eq(equipment.id, id), eq(equipment.tenantId, tenantId)))
      .limit(1);

    return row ?? null;
  }

  async findUnitRef(tenantId: string, id: string): Promise<IssuableUnit | null> {
    const [row] = await this.db
      .select(UNIT_COLUMNS)
      .from(equipment)
      .where(and(eq(equipment.id, id), eq(equipment.tenantId, tenantId)))
      .limit(1);

    return row ?? null;
  }

  async findAvailableUnit(tenantId: string, catalogId: string, serialOrBarcode?: string): Promise<IssuableUnit | null> {
    const conditions = [
      eq(equipment.catalogId, catalogId),
      eq(equipment.tenantId, tenantId),
      eq(equipment.inventoryStatus, INVENTORY_STATUS.AVAILABLE),
      sql`not ${activeAssignment()}`,
    ];

    if (serialOrBarcode !== undefined)
      conditions.push(or(eq(equipment.serialNumber, serialOrBarcode), eq(equipment.barcode, serialOrBarcode))!);

    const [unit] = await this.db.select(UNIT_COLUMNS).from(equipment).where(and(...conditions)).limit(1);

    return unit ?? null;
  }

  async findTransferableUnit(tenantId: string, catalogId: string, fromLocationId?: string) {
    const conditions = [
      eq(equipment.tenantId, tenantId),
      eq(equipment.catalogId, catalogId),
      eq(equipment.inventoryStatus, INVENTORY_STATUS.AVAILABLE),
      sql`not ${activeAssignment()}`,
    ];

    if (fromLocationId !== undefined)
      conditions.push(eq(equipment.locationId, fromLocationId));

    const [unit] = await this.db.select().from(equipment).where(and(...conditions)).limit(1);

    return unit ?? null;
  }

  async createUnit(data: typeof equipment.$inferInsert, tx?: Transaction): Promise<IssuableUnit> {
    const client = tx ?? this.db;
    const [created] = await client.insert(equipment).values(data).returning(UNIT_COLUMNS);
    return created!;
  }

  async isUnitAvailable(tenantId: string, id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: equipment.id })
      .from(equipment)
      .where(and(eq(equipment.tenantId, tenantId), eq(equipment.id, id), availableUnit()))
      .limit(1);

    return row !== undefined;
  }

  async updateUnit(tenantId: string, id: string, data: Partial<typeof equipment.$inferInsert>, tx?: Transaction) {
    const client = tx ?? this.db;
    const [updated] = await client
      .update(equipment)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(equipment.id, id), eq(equipment.tenantId, tenantId)))
      .returning();

    return updated ?? null;
  }

  // --- Customer equipment --------------------------------------------------

  async createAssignment(data: typeof customerEquipment.$inferInsert, tx?: Transaction) {
    const client = tx ?? this.db;
    const [created] = await client.insert(customerEquipment).values(data).returning();
    return created!;
  }

  async findAssignment(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(customerEquipment)
      .where(and(eq(customerEquipment.id, id), eq(customerEquipment.tenantId, tenantId)))
      .limit(1);

    return row ?? null;
  }

  async updateAssignment(tenantId: string, id: string, data: Partial<typeof customerEquipment.$inferInsert>, tx?: Transaction) {
    const client = tx ?? this.db;
    const [updated] = await client
      .update(customerEquipment)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(customerEquipment.id, id), eq(customerEquipment.tenantId, tenantId)))
      .returning();

    return updated!;
  }

  async listCustomerEquipment(tenantId: string, reach: SQL[], query: CustomerEquipmentQuery) {
    const conditions = [eq(customerEquipment.tenantId, tenantId), ...reach];

    if (query.customerId !== undefined)
      conditions.push(eq(customerEquipment.customerId, query.customerId));
    if (query.status !== undefined)
      conditions.push(eq(customerEquipment.status, query.status as CustomerEquipmentStatus));
    if (query.equipmentId !== undefined)
      conditions.push(eq(customerEquipment.equipmentId, query.equipmentId));

    return this.db
      .select({
        id: customerEquipment.id,
        customerId: customerEquipment.customerId,
        customerName: customers.name,
        customerCode: customers.customerCode,
        subscriptionId: customerEquipment.subscriptionId,
        equipmentId: customerEquipment.equipmentId,
        status: customerEquipment.status,
        ownershipType: customerEquipment.ownershipType,
        assignedAt: customerEquipment.assignedAt,
        returnedAt: customerEquipment.returnedAt,
        returnCondition: customerEquipment.returnCondition,
        returnRemarks: customerEquipment.returnRemarks,
        returnedToLocationId: customerEquipment.returnedToLocationId,
        depositRefundStatus: customerEquipment.depositRefundStatus,
        depositDeductionAmount: customerEquipment.depositDeductionAmount,
        itemName: itemCatalog.name,
        itemCode: itemCatalog.code,
        serialNumber: equipment.serialNumber,
        barcode: equipment.barcode,
        vcNumber: equipment.vcNumber,
        macAddress: equipment.macAddress,
      })
      .from(customerEquipment)
      .innerJoin(customers, eq(customerEquipment.customerId, customers.id))
      .innerJoin(equipment, eq(customerEquipment.equipmentId, equipment.id))
      .innerJoin(itemCatalog, eq(equipment.catalogId, itemCatalog.id))
      .where(and(...conditions))
      .orderBy(desc(customerEquipment.assignedAt))
      .limit(query.limit ?? 50);
  }

  // --- Stock movements -----------------------------------------------------

  async createMovement(data: typeof stockMovements.$inferInsert, tx?: Transaction): Promise<StockMovementRecord> {
    const client = tx ?? this.db;
    const [created] = await client.insert(stockMovements).values(data).returning();
    return created!;
  }

  async listMovements(tenantId: string, reach: SQL[], limit: number) {
    const locFrom = alias(locations, 'loc_from');
    const locTo = alias(locations, 'loc_to');
    const staffFrom = alias(users, 'staff_from');
    const staffTo = alias(users, 'staff_to');
    const perf = alias(users, 'perf');

    return this.db
      .select({
        id: stockMovements.id,
        equipmentId: stockMovements.equipmentId,
        movementType: stockMovements.movementType,
        quantity: stockMovements.quantity,
        notes: stockMovements.notes,
        createdAt: stockMovements.createdAt,
        itemName: sql<string>`coalesce(${itemCatalog.name}, 'Item')`,
        itemCode: itemCatalog.code,
        serialNumber: equipment.serialNumber,
        fromLocationName: locFrom.name,
        toLocationName: locTo.name,
        fromStaffName: staffFrom.name,
        toStaffName: staffTo.name,
        performedByName: perf.name,
      })
      .from(stockMovements)
      .innerJoin(equipment, eq(stockMovements.equipmentId, equipment.id))
      .leftJoin(itemCatalog, eq(equipment.catalogId, itemCatalog.id))
      .leftJoin(locFrom, eq(stockMovements.fromLocationId, locFrom.id))
      .leftJoin(locTo, eq(stockMovements.toLocationId, locTo.id))
      .leftJoin(staffFrom, eq(stockMovements.fromStaffId, staffFrom.id))
      .leftJoin(staffTo, eq(stockMovements.toStaffId, staffTo.id))
      .leftJoin(perf, eq(stockMovements.performedBy, perf.id))
      .where(and(eq(stockMovements.tenantId, tenantId), ...reach))
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit);
  }

  /** One inward unit plus its movement row; the caller supplies the transaction. */
  async inwardUnit(tx: Transaction, spec: {
    tenantId: string;
    catalog: { id: string; name: string };
    input: InwardStockBody;
    userId: string;
    serialNumber: string | null;
  }): Promise<StockMovementRecord> {
    const { tenantId, catalog, input, serialNumber } = spec;
    const locationId = input.locationId ?? null;

    const unit = await this.createUnit({
      tenantId,
      catalogId: catalog.id,
      locationId,
      ...(serialNumber === null ? {} : { serialNumber }),
      costPrice: input.costPrice ?? '0',
      depositAmount: input.depositAmount ?? '0',
      inventoryStatus: INVENTORY_STATUS.AVAILABLE,
    }, tx);

    const detail = serialNumber === null ? 'no serial' : `SN: ${serialNumber}`;

    return this.createMovement({
      tenantId,
      equipmentId: unit.id,
      movementType: STOCK_MOVEMENT_TYPE.INWARD,
      toLocationId: locationId,
      performedBy: spec.userId,
      quantity: 1,
      notes: input.notes ?? `Stock inward: ${catalog.name} (${detail})`,
    }, tx);
  }

  // --- Locations -----------------------------------------------------------

  async locationsWithStock(tenantId: string, stockReach: SQL[], locationReach: SQL[]) {
    return this.db
      .select({
        id: locations.id,
        name: locations.name,
        code: locations.code,
        itemCount: sql<number>`count(${equipment.id})::int`,
      })
      .from(locations)
      .leftJoin(equipment, and(
        eq(locations.id, equipment.locationId),
        eq(equipment.tenantId, tenantId),
        ...stockReach,
      ))
      .where(and(
        eq(locations.tenantId, tenantId),
        eq(locations.isActive, true),
        isNull(locations.deletedAt),
        ...locationReach,
        or(
          isNull(locations.parentId),
          sql`exists (select 1 from inventory.equipment eq where eq.location_id = ${locations.id} and eq.tenant_id = ${tenantId})`,
        ),
      ))
      .groupBy(locations.id, locations.name, locations.code)
      .orderBy(desc(sql`count(${equipment.id})`), locations.name);
  }

  // --- Lookup --------------------------------------------------------------

  async lookupUnits(tenantId: string, reach: SQL[], term: string, limit: number) {
    const pattern = `%${term}%`;

    return this.db
      .select({
        id: equipment.id,
        catalogId: equipment.catalogId,
        serialNumber: equipment.serialNumber,
        barcode: equipment.barcode,
        vcNumber: equipment.vcNumber,
        macAddress: equipment.macAddress,
        inventoryStatus: equipment.inventoryStatus,
        locationId: equipment.locationId,
        locationName: locations.name,
        catalogName: itemCatalog.name,
        catalogCode: itemCatalog.code,
        brand: itemCatalog.brand,
        model: itemCatalog.model,
        defaultSalePrice: itemCatalog.defaultSalePrice,
        defaultDepositAmount: itemCatalog.defaultDepositAmount,
      })
      .from(equipment)
      .innerJoin(itemCatalog, eq(equipment.catalogId, itemCatalog.id))
      .leftJoin(locations, and(eq(equipment.locationId, locations.id), isNull(locations.deletedAt)))
      .where(and(
        eq(equipment.tenantId, tenantId),
        isNull(itemCatalog.deletedAt),
        ...reach,
        or(
          eq(equipment.serialNumber, term),
          eq(equipment.barcode, term),
          eq(equipment.vcNumber, term),
          eq(equipment.macAddress, term),
          ilike(equipment.serialNumber, pattern),
          ilike(equipment.barcode, pattern),
          ilike(itemCatalog.name, pattern),
          ilike(itemCatalog.code, pattern),
        ),
      ))
      .limit(limit);
  }

  async lookupCatalog(tenantId: string, term: string, limit: number) {
    const pattern = `%${term}%`;

    return this.db
      .select({
        id: itemCatalog.id,
        name: itemCatalog.name,
        code: itemCatalog.code,
        brand: itemCatalog.brand,
        model: itemCatalog.model,
        defaultSalePrice: itemCatalog.defaultSalePrice,
        defaultDepositAmount: itemCatalog.defaultDepositAmount,
        availableStock: sql<number>`count(*) FILTER (WHERE ${availableUnit()})::int`,
      })
      .from(itemCatalog)
      .leftJoin(equipment, and(eq(itemCatalog.id, equipment.catalogId), eq(equipment.tenantId, tenantId)))
      .where(and(
        eq(itemCatalog.tenantId, tenantId),
        isNull(itemCatalog.deletedAt),
        or(
          eq(itemCatalog.code, term),
          ilike(itemCatalog.name, pattern),
          ilike(itemCatalog.code, pattern),
          ilike(itemCatalog.brand, pattern),
          ilike(itemCatalog.model, pattern),
        ),
      ))
      .groupBy(itemCatalog.id)
      .limit(limit);
  }

  // --- Approval requests ---------------------------------------------------

  async createApprovalRequest(data: typeof approvalRequests.$inferInsert) {
    const [created] = await this.db.insert(approvalRequests).values(data).returning();
    return created!;
  }

  async findApprovalRequest(tenantId: string, id: string) {
    const [req] = await this.db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.tenantId, tenantId)))
      .limit(1);

    return req ?? null;
  }

  async updateApprovalRequest(tenantId: string, id: string, data: Partial<typeof approvalRequests.$inferInsert>) {
    const [updated] = await this.db
      .update(approvalRequests)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.tenantId, tenantId)))
      .returning();

    return updated!;
  }

  async listApprovalRequests(tenantId: string, requestedBy?: string) {
    const reviewer = alias(users, 'reviewer');
    const conditions = [eq(approvalRequests.tenantId, tenantId)];

    if (requestedBy !== undefined)
      conditions.push(eq(approvalRequests.requestedBy, requestedBy));

    return this.db
      .select({
        id: approvalRequests.id,
        requestedBy: approvalRequests.requestedBy,
        requestedByName: users.name,
        requestType: approvalRequests.requestType,
        targetItemId: approvalRequests.targetItemId,
        targetItemName: itemCatalog.name,
        proposedData: approvalRequests.proposedData,
        reason: approvalRequests.reason,
        status: approvalRequests.status,
        reviewedBy: approvalRequests.reviewedBy,
        reviewedByName: reviewer.name,
        reviewedAt: approvalRequests.reviewedAt,
        reviewNotes: approvalRequests.reviewNotes,
        createdAt: approvalRequests.createdAt,
      })
      .from(approvalRequests)
      .leftJoin(users, eq(approvalRequests.requestedBy, users.id))
      .leftJoin(itemCatalog, eq(approvalRequests.targetItemId, itemCatalog.id))
      .leftJoin(reviewer, eq(approvalRequests.reviewedBy, reviewer.id))
      .where(and(...conditions))
      .orderBy(desc(approvalRequests.createdAt));
  }
}

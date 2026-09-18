import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Static, TSchema } from 'typebox';
import type {
  CreateApprovalRequestBody,
  CustomerEquipmentItem,
  CustomerEquipmentQuery,
  InventoryDashboardResponse,
  InventoryLocationResponse,
  InwardStockBody,
  IssueEquipmentBody,
  IssueEquipmentResponse,
  ItemDetailsResponse,
  ListStockQuery,
  LookupItemResponse,
  ReturnCustomerEquipmentBody,
  ReturnCustomerEquipmentResponse,
  ReviewApprovalRequestBody,
  StockItemResponse,
  TransferStockBody,
} from './inventory.schema';
import type { CustomerEquipmentStatus, EquipmentOwnership } from '@/constants/inventory';
import type * as schema from '@/db/schema';
import type { StockMovementRecord } from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { LocationsService } from '@/modules/locations/location.service';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Assert, Errors } from 'typebox/value';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { SUBSCRIPTION_STATUS } from '@/constants/crm';
import {
  CUSTOMER_EQUIPMENT_STATUS,
  EQUIPMENT_OWNERSHIP,
  EQUIPMENT_RETURN_CONDITION,
  INVENTORY_REQUEST_STATUS,
  INVENTORY_REQUEST_TYPE,
  INVENTORY_STATUS,
  STOCK_LEVEL_FILTER,
  STOCK_MOVEMENT_TYPE,
} from '@/constants/inventory';
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
import { ERROR_CODES } from '@/errors';
import { badRequest, conflict, forbidden, inUse, notFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { locationScopeFor } from '@/modules/iam/access.service';
import { withinGrantedSubtree } from '@/security/location-scope';
import { PERMISSIONS } from '@/security/permissions';
import { CreateCatalogItemBody, UpdateCatalogItemBody } from './inventory.schema';

type Db = NodePgDatabase<typeof schema>;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function catalogRowFrom(tenantId: string, input: CreateCatalogItemBody) {
  return {
    tenantId,
    name: input.name,
    code: input.code ?? null,
    brand: input.brand ?? null,
    model: input.model ?? null,
    isBundle: input.isBundle ?? false,
    defaultOwnership: input.defaultOwnership ?? EQUIPMENT_OWNERSHIP.TENANT_PROVIDED,
    defaultSalePrice: input.defaultSalePrice ?? '0',
    defaultDepositAmount: input.defaultDepositAmount ?? '0',
    defaultRentalPrice: input.defaultRentalPrice ?? '0',
    isReturnable: input.isReturnable ?? true,
    description: input.description ?? null,
  };
}

function parseProposed<T extends TSchema>(schema: T, value: Record<string, unknown>): Static<T> {
  try {
    Assert(schema, value);
    return value;
  }
  catch {
    const problems = [...Errors(schema, value)]
      .map(issue => `${issue.instancePath || '/'}: ${issue.message}`)
      .join('; ');
    throw badRequest(ERROR_CODES.VALIDATION_FAILED, `The proposed change is not valid: ${problems}`);
  }
}

export class InventoryService {
  constructor(private readonly db: Db, private readonly locations: LocationsService) {}

  private async assertLocations(access: RequestAccess, ids: readonly (string | undefined)[]): Promise<void> {
    await this.locations.assertWithinReach(
      access,
      PERMISSIONS.INVENTORY_UPDATE,
      ids.filter((id): id is string => id !== undefined),
    );
  }

  private async assertStaffMember(tenantId: string, userId: string | undefined): Promise<void> {
    if (userId === undefined)
      return;

    const [member] = await this.db
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, userId),
        isNull(tenantMemberships.deletedAt),
      ))
      .limit(1);

    if (member === undefined)
      throw notFound('Staff member');
  }

  private canManageCatalog(access: RequestAccess): boolean {
    return access.permissions.has(PERMISSIONS.INVENTORY_MANAGE_CATALOG);
  }

  private visibleStock(access: RequestAccess): SQL[] {
    const reach = locationScopeFor(access, PERMISSIONS.INVENTORY_VIEW);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [or(
      withinGrantedSubtree(sql`${equipment.locationId}`, reach.nodeIds),
      eq(equipment.staffId, access.userId),
    )!];
  }

  private visibleLocations(access: RequestAccess): SQL[] {
    const reach = locationScopeFor(access, PERMISSIONS.INVENTORY_VIEW);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [withinGrantedSubtree(sql`${locations.id}`, reach.nodeIds)];
  }

  async getDashboard(access: RequestAccess, locationId?: string): Promise<InventoryDashboardResponse> {
    const tenantId = access.tenantId;

    let locationName: string | null = null;
    if (locationId !== undefined) {
      const [loc] = await this.db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(and(eq(locations.id, locationId), eq(locations.tenantId, tenantId)))
        .limit(1);
      locationName = loc?.name ?? null;
    }

    const eqConditions = [eq(equipment.tenantId, tenantId), ...this.visibleStock(access)];
    if (locationId !== undefined) {
      eqConditions.push(eq(equipment.locationId, locationId));
    }
    const eqWhere = and(...eqConditions);

    const statsQuery = await this.db
      .select({
        total: sql<number>`count(${equipment.id})::int`,
        inStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.AVAILABLE})::int`,
        issued: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.ALLOCATED})::int`,
        inTransit: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.STAFF_VAN})::int`,
      })
      .from(equipment)
      .where(eqWhere);

    const stats = statsQuery[0] ?? { total: 0, inStock: 0, issued: 0, inTransit: 0 };

    const catalogRows = await this.db
      .select({
        id: itemCatalog.id,
        name: itemCatalog.name,
        code: itemCatalog.code,
        totalStock: sql<number>`count(${equipment.id})::int`,
        availableStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.AVAILABLE})::int`,
      })
      .from(itemCatalog)
      .leftJoin(equipment, and(eq(itemCatalog.id, equipment.catalogId), ...eqConditions))
      .where(and(eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)))
      .groupBy(itemCatalog.id, itemCatalog.name, itemCatalog.code)
      .having(sql`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.AVAILABLE}) <= 10`)
      .limit(5);

    const locFrom = alias(locations, 'loc_from');
    const locTo = alias(locations, 'loc_to');

    const movements = await this.db
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
      .where(and(eq(stockMovements.tenantId, tenantId), ...this.visibleStock(access)))
      .orderBy(desc(stockMovements.createdAt))
      .limit(5);

    return {
      locationId: locationId ?? null,
      locationName,
      totalItems: stats.total,
      inStock: stats.inStock,
      issued: stats.issued,
      inTransit: stats.inTransit,
      lowStockItems: catalogRows.map(row => ({
        id: row.id,
        name: row.name,
        code: row.code,
        availableStock: row.availableStock,
        totalStock: row.totalStock,
      })),
      recentMovements: movements.map(m => ({
        id: m.id,
        movementType: m.movementType,
        itemName: m.itemName,
        itemCode: m.itemCode,
        targetName: m.toLocationName !== null ? `To ${m.toLocationName}` : m.notes,
        fromLocationName: m.fromLocationName,
        toLocationName: m.toLocationName,
        quantity: m.quantity,
        performedByName: m.performedByName,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async getStockList(access: RequestAccess, query: ListStockQuery): Promise<StockItemResponse[]> {
    const tenantId = access.tenantId;

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

    let queriedLocationName: string | null = null;
    if (query.locationId !== undefined) {
      const [loc] = await this.db
        .select({ name: locations.name })
        .from(locations)
        .where(and(eq(locations.id, query.locationId), eq(locations.tenantId, tenantId)))
        .limit(1);
      queriedLocationName = loc?.name ?? null;
    }

    const eqFilter = [eq(equipment.tenantId, tenantId), ...this.visibleStock(access)];
    if (query.locationId !== undefined) {
      eqFilter.push(eq(equipment.locationId, query.locationId));
    }

    const rows = await this.db
      .select({
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

        totalStock: sql<number>`count(${equipment.id})::int`,
        availableStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.AVAILABLE})::int`,
        issuedStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.ALLOCATED})::int`,
        inTransitStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.WITH_STAFF})::int`,
        aggregatedLocationName: sql<string | null>`max(${locations.name})`,
        aggregatedLocationId: sql<string | null>`max(${equipment.locationId}::text)`,

        bundleContents: sql<ItemDetailsResponse['bundleComponents']>`'[]'::jsonb`,
      })
      .from(itemCatalog)
      .leftJoin(equipment, and(eq(itemCatalog.id, equipment.catalogId), ...eqFilter))
      .leftJoin(locations, eq(equipment.locationId, locations.id))
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

    let result = rows.map(r => ({
      ...r,
      locationId: query.locationId ?? r.aggregatedLocationId,
      locationName: queriedLocationName ?? r.aggregatedLocationName,
    }));

    if (query.status === STOCK_LEVEL_FILTER.IN_STOCK) {
      result = result.filter(r => r.availableStock > 0);
    }
    else if (query.status === STOCK_LEVEL_FILTER.LOW_STOCK) {
      result = result.filter(r => r.availableStock <= 10);
    }

    return result;
  }

  async getItemDetails(access: RequestAccess, id: string): Promise<ItemDetailsResponse> {
    const tenantId = access.tenantId;

    const [catalog] = await this.db
      .select({
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
      })
      .from(itemCatalog)
      .where(and(eq(itemCatalog.id, id), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)));

    if (!catalog) {
      throw notFound('Item not found in catalog');
    }

    const unitRows = await this.db
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
      .leftJoin(locations, eq(equipment.locationId, locations.id))
      .leftJoin(users, eq(equipment.staffId, users.id))
      .where(and(eq(equipment.catalogId, id), eq(equipment.tenantId, tenantId), ...this.visibleStock(access)))
      .limit(50);

    const [totals] = await this.db
      .select({
        totalStock: sql<number>`count(*)::int`,
        availableStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.AVAILABLE})::int`,
        issuedStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.ALLOCATED})::int`,
        inTransitStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.STAFF_VAN})::int`,
      })
      .from(equipment)
      .where(and(eq(equipment.catalogId, id), eq(equipment.tenantId, tenantId), ...this.visibleStock(access)));

    const { totalStock = 0, availableStock = 0, issuedStock = 0, inTransitStock = 0 } = totals ?? {};

    const firstUnitWithLoc = unitRows.find(u => u.locationName != null);
    const itemLocationId = firstUnitWithLoc?.locationId ?? null;
    const itemLocationName = firstUnitWithLoc?.locationName ?? null;

    return {
      ...catalog,
      bundleContents: [],
      totalStock,
      availableStock,
      issuedStock,
      inTransitStock,
      locationId: itemLocationId,
      locationName: itemLocationName,
      units: unitRows.map(u => ({
        id: u.id,
        serialNumber: u.serialNumber,
        vcNumber: u.vcNumber,
        macAddress: u.macAddress,
        barcode: u.barcode,
        inventoryStatus: u.inventoryStatus,
        locationName: u.locationName,
        staffName: u.staffName,
      })),
      bundleComponents: [],
    };
  }

  private async resolveIssuableUnit(spec: {
    tenantId: string;
    input: IssueEquipmentBody;
    customer: { id: string; name?: string | null; code?: string | null; locationId?: string | null };
    defaultOwnership: EquipmentOwnership;
  }): Promise<{ unitId: string; serialNumber: string | null; unitLocationId: string | null }> {
    const { tenantId, input, customer, defaultOwnership } = spec;
    const columns = { id: equipment.id, serialNumber: equipment.serialNumber, locationId: equipment.locationId };

    if (input.equipmentId !== undefined) {
      const [existingUnit] = await this.db
        .select(columns)
        .from(equipment)
        .where(and(eq(equipment.id, input.equipmentId), eq(equipment.tenantId, tenantId)))
        .limit(1);

      if (existingUnit === undefined)
        throw notFound('Equipment');

      return {
        unitId: existingUnit.id,
        serialNumber: existingUnit.serialNumber ?? input.serialNumber ?? null,
        unitLocationId: existingUnit.locationId,
      };
    }

    const eqWhere = [
      eq(equipment.catalogId, input.catalogId),
      eq(equipment.tenantId, tenantId),
      eq(equipment.inventoryStatus, INVENTORY_STATUS.AVAILABLE),
    ];
    if (input.serialNumber !== undefined)
      eqWhere.push(or(eq(equipment.serialNumber, input.serialNumber), eq(equipment.barcode, input.serialNumber))!);

    const [unit] = await this.db.select(columns).from(equipment).where(and(...eqWhere)).limit(1);
    if (unit)
      return { unitId: unit.id, serialNumber: unit.serialNumber, unitLocationId: unit.locationId };

    const [createdUnit] = await this.db
      .insert(equipment)
      .values({
        tenantId,
        catalogId: input.catalogId,
        locationId: customer.locationId ?? null,
        serialNumber: input.serialNumber ?? `SN-${Date.now().toString().slice(-6)}`,
        inventoryStatus: INVENTORY_STATUS.AVAILABLE,
        ownershipType: input.ownershipType ?? defaultOwnership,
      })
      .returning(columns);

    return {
      unitId: createdUnit!.id,
      serialNumber: createdUnit!.serialNumber,
      unitLocationId: createdUnit!.locationId,
    };
  }

  private async assertSubscriptionOf(tenantId: string, customerId: string, subscriptionId: string): Promise<void> {
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

    if (line === undefined)
      throw notFound('Subscription');
  }

  private async resolveSubscriptionId(tenantId: string, customer: {
    id: string;
    code: string | null;
    locationId?: string | null;
  }): Promise<string> {
    const [sub] = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.customerId, customer.id), eq(subscriptions.tenantId, tenantId)))
      .limit(1);

    if (sub)
      return sub.id;

    const [pkg] = await this.db
      .select({ packageId: packages.id, providerId: packages.serviceProviderId })
      .from(packages)
      .where(eq(packages.tenantId, tenantId))
      .limit(1);

    if (!pkg)
      throw notFound('No active subscription or package found for customer');

    const locationId = await this.anyLocationId(tenantId);
    if (locationId === null)
      throw notFound('No location found for subscription');

    const [newSub] = await this.db
      .insert(subscriptions)
      .values({
        tenantId,
        customerId: customer.id,
        installationLocationId: locationId,
        serviceProviderId: pkg.providerId,
        packageId: pkg.packageId,
        serviceAccountNumber: `SA-${customer.code ?? Date.now().toString().slice(-6)}`,
        status: SUBSCRIPTION_STATUS.ACTIVE,
      })
      .returning({ id: subscriptions.id });

    return newSub!.id;
  }

  private async anyLocationId(tenantId: string): Promise<string | null> {
    const [location] = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.tenantId, tenantId))
      .limit(1);

    return location?.id ?? null;
  }

  async issueEquipment(access: RequestAccess, input: IssueEquipmentBody): Promise<IssueEquipmentResponse> {
    const tenantId = access.tenantId;

    const [cust] = await this.db
      .select({ id: customers.id, name: customers.name, code: customers.customerCode })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.tenantId, tenantId)));

    if (!cust) {
      throw notFound('Customer not found');
    }

    const [catalog] = await this.db
      .select({ id: itemCatalog.id, name: itemCatalog.name, code: itemCatalog.code, defaultOwnership: itemCatalog.defaultOwnership })
      .from(itemCatalog)
      .where(and(eq(itemCatalog.id, input.catalogId), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)));

    if (!catalog) {
      throw notFound('Catalog item not found');
    }

    const { unitId, serialNumber, unitLocationId } = await this.resolveIssuableUnit({
      tenantId,
      input,
      customer: cust,
      defaultOwnership: catalog.defaultOwnership,
    });

    if (input.subscriptionId !== undefined)
      await this.assertSubscriptionOf(tenantId, cust.id, input.subscriptionId);

    const resolvedSubId = input.subscriptionId ?? await this.resolveSubscriptionId(tenantId, cust);

    const result = await this.db.transaction(async (tx) => {
      await tx
        .update(equipment)
        .set({
          inventoryStatus: INVENTORY_STATUS.ALLOCATED,
          locationId: unitLocationId,
          updatedAt: new Date(),
        })
        .where(and(eq(equipment.id, unitId), eq(equipment.tenantId, tenantId)));

      const [assignment] = await tx
        .insert(customerEquipment)
        .values({
          tenantId,
          customerId: cust.id,
          subscriptionId: resolvedSubId,
          equipmentId: unitId,
          status: CUSTOMER_EQUIPMENT_STATUS.ACTIVE,
          ownershipType: input.ownershipType ?? catalog.defaultOwnership,
          assignedBy: access.userId,
          notes: input.notes ?? null,
        })
        .returning();

      await tx.insert(stockMovements).values({
        tenantId,
        equipmentId: unitId,
        movementType: STOCK_MOVEMENT_TYPE.CUSTOMER_ISSUE,
        fromLocationId: unitLocationId,
        toLocationId: unitLocationId,
        performedBy: access.userId,
        quantity: 1,
        notes: `Issued to customer ${cust.name} (${cust.code ?? ''})`,
      });

      return assignment!;
    });

    await audit.created(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_CUSTOMER_EQUIPMENT,
      entityId: result.id,
      after: result,
    });

    return {
      id: result.id,
      equipmentId: unitId,
      customerId: cust.id,
      customerName: cust.name ?? 'Customer',
      customerCode: cust.code,
      subscriptionId: result.subscriptionId,
      itemName: catalog.name,
      itemCode: catalog.code,
      serialNumber,
      status: result.status,
      ownershipType: result.ownershipType,
      assignedAt: result.assignedAt.toISOString(),
    };
  }

  async createCatalogItem(access: RequestAccess, input: CreateCatalogItemBody) {
    if (!this.canManageCatalog(access)) {
      throw forbidden(ERROR_CODES.PERM_DENIED, `Changing the item catalog needs ${PERMISSIONS.INVENTORY_MANAGE_CATALOG} — submit an approval request instead`);
    }

    const tenantId = access.tenantId;

    const [created] = await this.db
      .insert(itemCatalog)
      .values(catalogRowFrom(tenantId, input))
      .returning();

    await audit.created(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_ITEM,
      entityId: created!.id,
      after: created!,
    });

    return created!;
  }

  async updateCatalogItem(access: RequestAccess, id: string, input: UpdateCatalogItemBody) {
    if (!this.canManageCatalog(access)) {
      throw forbidden(ERROR_CODES.PERM_DENIED, `Changing the item catalog needs ${PERMISSIONS.INVENTORY_MANAGE_CATALOG} — submit an approval request instead`);
    }

    const tenantId = access.tenantId;

    const [existing] = await this.db
      .select()
      .from(itemCatalog)
      .where(and(eq(itemCatalog.id, id), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)));

    if (!existing) {
      throw notFound('Item not found');
    }

    const [updated] = await this.db
      .update(itemCatalog)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(and(eq(itemCatalog.id, id), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)))
      .returning();

    await audit.updated(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_ITEM,
      entityId: id,
      before: existing,
      after: updated!,
    });

    return updated;
  }

  async deleteCatalogItem(access: RequestAccess, id: string) {
    if (!this.canManageCatalog(access)) {
      throw forbidden(ERROR_CODES.PERM_DENIED, `Changing the item catalog needs ${PERMISSIONS.INVENTORY_MANAGE_CATALOG}`);
    }

    const tenantId = access.tenantId;

    const [existing] = await this.db
      .select()
      .from(itemCatalog)
      .where(and(eq(itemCatalog.id, id), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)));

    if (!existing) {
      throw notFound('Item not found');
    }

    const [live] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(equipment)
      .where(and(
        eq(equipment.tenantId, tenantId),
        eq(equipment.catalogId, id),
        sql`${equipment.inventoryStatus} <> ${INVENTORY_STATUS.RETIRED}`,
      ));

    if ((live?.total ?? 0) > 0)
      throw inUse(`${live!.total} unit(s) of this item are still on the books; retire them first`);

    await this.db
      .update(itemCatalog)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(itemCatalog.id, id), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)));

    await audit.deleted(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_ITEM,
      entityId: id,
      before: existing,
    });

    return { success: true as const };
  }

  async createApprovalRequest(access: RequestAccess, input: CreateApprovalRequestBody) {
    const tenantId = access.tenantId;

    const [created] = await this.db
      .insert(approvalRequests)
      .values({
        tenantId,
        requestedBy: access.userId,
        requestType: input.requestType,
        targetItemId: input.targetItemId ?? null,
        proposedData: input.proposedData ?? null,
        reason: input.reason,
        status: INVENTORY_REQUEST_STATUS.PENDING,
      })
      .returning();

    await audit.created(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_APPROVAL_REQUEST,
      entityId: created!.id,
      after: created!,
    });

    return created!;
  }

  async listApprovalRequests(access: RequestAccess) {
    const tenantId = access.tenantId;

    const conditions = [eq(approvalRequests.tenantId, tenantId)];

    if (!this.canManageCatalog(access)) {
      conditions.push(eq(approvalRequests.requestedBy, access.userId));
    }

    const rows = await this.db
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
        reviewedByName: sql<string>`reviewer.name`,
        reviewedAt: approvalRequests.reviewedAt,
        reviewNotes: approvalRequests.reviewNotes,
        createdAt: approvalRequests.createdAt,
      })
      .from(approvalRequests)
      .leftJoin(users, eq(approvalRequests.requestedBy, users.id))
      .leftJoin(itemCatalog, eq(approvalRequests.targetItemId, itemCatalog.id))
      .leftJoin(sql`${users} as reviewer`, sql`${approvalRequests.reviewedBy} = reviewer.id`)
      .where(and(...conditions))
      .orderBy(desc(approvalRequests.createdAt));

    return rows.map(r => ({
      ...r,
      proposedData: r.proposedData,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async reviewApprovalRequest(access: RequestAccess, id: string, input: ReviewApprovalRequestBody) {
    if (!this.canManageCatalog(access)) {
      throw forbidden(ERROR_CODES.PERM_DENIED, `Reviewing a change request needs ${PERMISSIONS.INVENTORY_MANAGE_CATALOG}`);
    }

    const tenantId = access.tenantId;

    const [req] = await this.db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.tenantId, tenantId)));

    if (!req) {
      throw notFound('Approval request not found');
    }

    if (req.status !== INVENTORY_REQUEST_STATUS.PENDING)
      throw conflict('This request has already been reviewed');

    if (input.status === INVENTORY_REQUEST_STATUS.APPROVED) {
      await this.applyApprovedRequest(access, req);
    }

    const [updated] = await this.db
      .update(approvalRequests)
      .set({
        status: input.status,
        reviewedBy: access.userId,
        reviewedAt: new Date(),
        reviewNotes: input.reviewNotes ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.tenantId, tenantId)))
      .returning();

    await audit.updated(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_APPROVAL_REQUEST,
      entityId: id,
      before: req,
      after: updated!,
    });

    return updated;
  }

  private async applyApprovedRequest(access: RequestAccess, req: typeof approvalRequests.$inferSelect) {
    const proposed = req.proposedData;

    if (req.requestType === INVENTORY_REQUEST_TYPE.CREATE_ITEM && proposed !== null) {
      await this.createCatalogItem(access, parseProposed(CreateCatalogItemBody, proposed));
    }
    else if (req.requestType === INVENTORY_REQUEST_TYPE.UPDATE_ITEM && req.targetItemId !== null && proposed !== null) {
      await this.updateCatalogItem(access, req.targetItemId, parseProposed(UpdateCatalogItemBody, proposed));
    }
    else if (req.requestType === INVENTORY_REQUEST_TYPE.DELETE_ITEM && req.targetItemId !== null) {
      await this.deleteCatalogItem(access, req.targetItemId);
    }
  }

  async getMovements(access: RequestAccess, limit = 50) {
    const tenantId = access.tenantId;
    const locFrom = alias(locations, 'loc_from');
    const locTo = alias(locations, 'loc_to');
    const staffFrom = alias(users, 'staff_from');
    const staffTo = alias(users, 'staff_to');
    const perf = alias(users, 'perf');

    const rows = await this.db
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
      .where(and(eq(stockMovements.tenantId, tenantId), ...this.visibleStock(access)))
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit);

    return rows.map(r => ({
      ...r,
      movementType: r.movementType,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async getLocations(access: RequestAccess): Promise<InventoryLocationResponse[]> {
    const tenantId = access.tenantId;

    const rows = await this.db
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
        ...this.visibleStock(access),
      ))
      .where(
        and(
          eq(locations.tenantId, tenantId),
          eq(locations.isActive, true),
          ...this.visibleLocations(access),
          or(
            isNull(locations.parentId),
            sql`exists (select 1 from inventory.equipment eq where eq.location_id = ${locations.id} and eq.tenant_id = ${tenantId})`,
          ),
        ),
      )
      .groupBy(locations.id, locations.name, locations.code)
      .orderBy(desc(sql`count(${equipment.id})`), locations.name);

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      code: r.code,
      itemCount: r.itemCount,
    }));
  }

  async lookup(access: RequestAccess, queryStr: string): Promise<LookupItemResponse[]> {
    const tenantId = access.tenantId;
    const q = queryStr.trim();
    if (!q)
      return [];

    const searchPattern = `%${q}%`;

    const eqRows = await this.db
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
      .leftJoin(locations, eq(equipment.locationId, locations.id))
      .where(
        and(
          eq(equipment.tenantId, tenantId),
          ...this.visibleStock(access),
          or(
            eq(equipment.serialNumber, q),
            eq(equipment.barcode, q),
            eq(equipment.vcNumber, q),
            eq(equipment.macAddress, q),
            ilike(equipment.serialNumber, searchPattern),
            ilike(equipment.barcode, searchPattern),
            ilike(itemCatalog.name, searchPattern),
            ilike(itemCatalog.code, searchPattern),
          ),
        ),
      )
      .limit(20);

    const catRows = await this.db
      .select({
        id: itemCatalog.id,
        name: itemCatalog.name,
        code: itemCatalog.code,
        brand: itemCatalog.brand,
        model: itemCatalog.model,
        defaultSalePrice: itemCatalog.defaultSalePrice,
        defaultDepositAmount: itemCatalog.defaultDepositAmount,
        availableStock: sql<number>`count(*) FILTER (WHERE ${equipment.inventoryStatus} = ${INVENTORY_STATUS.AVAILABLE})::int`,
      })
      .from(itemCatalog)
      .leftJoin(equipment, and(eq(itemCatalog.id, equipment.catalogId), eq(equipment.tenantId, tenantId)))
      .where(
        and(
          eq(itemCatalog.tenantId, tenantId),
          isNull(itemCatalog.deletedAt),
          or(
            eq(itemCatalog.code, q),
            ilike(itemCatalog.name, searchPattern),
            ilike(itemCatalog.code, searchPattern),
            ilike(itemCatalog.brand, searchPattern),
            ilike(itemCatalog.model, searchPattern),
          ),
        ),
      )
      .groupBy(itemCatalog.id)
      .limit(10);

    const results: LookupItemResponse[] = [];

    for (const r of eqRows) {
      results.push({
        type: 'equipment',
        id: r.id,
        catalogId: r.catalogId!,
        itemName: r.catalogName,
        itemCode: r.catalogCode,
        brand: r.brand,
        model: r.model,
        serialNumber: r.serialNumber,
        barcode: r.barcode,
        vcNumber: r.vcNumber,
        macAddress: r.macAddress,
        inventoryStatus: r.inventoryStatus,
        locationId: r.locationId,
        locationName: r.locationName,
        defaultSalePrice: r.defaultSalePrice,
        defaultDepositAmount: r.defaultDepositAmount,
        availableStock: r.inventoryStatus === INVENTORY_STATUS.AVAILABLE ? 1 : 0,
      });
    }

    for (const c of catRows) {
      results.push({
        type: 'catalog',
        id: c.id,
        catalogId: c.id,
        itemName: c.name,
        itemCode: c.code,
        brand: c.brand,
        model: c.model,
        serialNumber: null,
        barcode: null,
        vcNumber: null,
        macAddress: null,
        inventoryStatus: INVENTORY_STATUS.AVAILABLE,
        locationId: null,
        locationName: null,
        defaultSalePrice: c.defaultSalePrice,
        defaultDepositAmount: c.defaultDepositAmount,
        availableStock: c.availableStock,
      });
    }

    return results;
  }

  async listCustomerEquipment(access: RequestAccess, query: CustomerEquipmentQuery): Promise<CustomerEquipmentItem[]> {
    const tenantId = access.tenantId;

    const conditions = [eq(customerEquipment.tenantId, tenantId), ...this.visibleStock(access)];
    if (query.customerId !== undefined) {
      conditions.push(eq(customerEquipment.customerId, query.customerId));
    }
    if (query.status !== undefined) {
      conditions.push(eq(customerEquipment.status, query.status as CustomerEquipmentStatus));
    }
    if (query.equipmentId !== undefined) {
      conditions.push(eq(customerEquipment.equipmentId, query.equipmentId));
    }

    const rows = await this.db
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

    return rows.map(r => ({
      ...r,
      customerName: r.customerName ?? 'Customer',
      assignedAt: r.assignedAt.toISOString(),
      returnedAt: r.returnedAt ? r.returnedAt.toISOString() : null,
      returnCondition: r.returnCondition ?? null,
      returnRemarks: r.returnRemarks ?? null,
      returnedToLocationId: r.returnedToLocationId ?? null,
      depositRefundStatus: r.depositRefundStatus,
      depositDeductionAmount: r.depositDeductionAmount,
    }));
  }

  async returnCustomerEquipment(access: RequestAccess, input: ReturnCustomerEquipmentBody): Promise<ReturnCustomerEquipmentResponse> {
    const tenantId = access.tenantId;

    const [assignment] = await this.db
      .select()
      .from(customerEquipment)
      .where(and(
        eq(customerEquipment.id, input.customerEquipmentId),
        eq(customerEquipment.tenantId, tenantId),
      ))
      .limit(1);

    if (!assignment) {
      throw notFound('Customer equipment assignment not found');
    }

    if (assignment.status === CUSTOMER_EQUIPMENT_STATUS.RETURNED) {
      throw badRequest(ERROR_CODES.RESOURCE_CONFLICT, 'Equipment has already been returned');
    }

    const [unit] = await this.db
      .select()
      .from(equipment)
      .where(and(eq(equipment.id, assignment.equipmentId), eq(equipment.tenantId, tenantId)))
      .limit(1);

    if (!unit) {
      throw notFound('Physical equipment record not found');
    }

    const returnCondition = input.returnCondition ?? EQUIPMENT_RETURN_CONDITION.WORKING;
    const isFaultyOrDamaged = returnCondition === EQUIPMENT_RETURN_CONDITION.FAULTY || returnCondition === EQUIPMENT_RETURN_CONDITION.DAMAGED;
    const nextInventoryStatus = isFaultyOrDamaged
      ? INVENTORY_STATUS.FAULTY
      : INVENTORY_STATUS.AVAILABLE;

    const targetLocationId = input.returnedToLocationId ?? unit.locationId;
    if (input.returnedToLocationId !== undefined) {
      await this.assertLocations(access, [input.returnedToLocationId]);
    }

    const now = new Date();

    const result = await this.db.transaction(async (tx) => {
      const [updatedAssignment] = await tx
        .update(customerEquipment)
        .set({
          status: CUSTOMER_EQUIPMENT_STATUS.RETURNED,
          returnedAt: now,
          returnCondition,
          collectedBy: access.userId,
          returnedToLocationId: targetLocationId,
          returnRemarks: input.returnRemarks ?? null,
          depositRefundStatus: input.depositRefundStatus ?? 'not_applicable',
          depositDeductionAmount: input.depositDeductionAmount ?? '0',
          notes: input.notes ?? assignment.notes,
          updatedAt: now,
        })
        .where(and(
          eq(customerEquipment.id, assignment.id),
          eq(customerEquipment.tenantId, tenantId),
        ))
        .returning();

      await tx
        .update(equipment)
        .set({
          inventoryStatus: nextInventoryStatus,
          locationId: targetLocationId,
          staffId: null,
          updatedAt: now,
        })
        .where(and(eq(equipment.id, unit.id), eq(equipment.tenantId, tenantId)));

      await tx.insert(stockMovements).values({
        tenantId,
        equipmentId: unit.id,
        movementType: STOCK_MOVEMENT_TYPE.CUSTOMER_RETURN,
        fromLocationId: unit.locationId,
        toLocationId: targetLocationId,
        performedBy: access.userId,
        quantity: 1,
        notes: `Customer return (${returnCondition}): ${input.returnRemarks ?? 'No remarks'}`,
      });

      return updatedAssignment!;
    });

    await audit.updated(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_CUSTOMER_EQUIPMENT,
      entityId: result.id,
      before: assignment,
      after: result,
    });

    return {
      id: result.id,
      equipmentId: result.equipmentId,
      customerId: result.customerId,
      status: result.status,
      returnedAt: result.returnedAt!.toISOString(),
      returnCondition: result.returnCondition,
      equipmentStatus: nextInventoryStatus,
    };
  }

  async inwardStock(access: RequestAccess, input: InwardStockBody) {
    const tenantId = access.tenantId;

    await this.assertLocations(access, [input.locationId]);

    const [catalog] = await this.db
      .select()
      .from(itemCatalog)
      .where(and(eq(itemCatalog.id, input.catalogId), eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)))
      .limit(1);

    if (!catalog) {
      throw notFound('Item in catalog');
    }

    const serials = input.serialNumbers?.filter(Boolean) ?? [];

    const quantity = Math.max(input.quantity ?? serials.length, serials.length, 1);

    const numbers: (string | null)[] = Array.from(
      { length: quantity },
      (_, index) => serials[index] ?? null,
    );

    const insertedMovements: StockMovementRecord[] = [];

    await this.db.transaction(async (tx) => {
      const base = { tenantId, catalog, input, userId: access.userId };

      for (const serialNumber of numbers)
        insertedMovements.push(await this.inwardUnit(tx, { ...base, serialNumber }));
    });

    const primaryMovement = insertedMovements[0];
    if (primaryMovement !== undefined) {
      await audit.created(this.db, access.audit, {
        entityType: AUDIT_ENTITIES.INVENTORY_STOCK_MOVEMENT,
        entityId: primaryMovement.id,
        after: primaryMovement,
      });
    }

    return {
      success: true,
      quantity,
      movementId: primaryMovement?.id ?? null,
    };
  }

  private async inwardUnit(tx: Tx, spec: {
    tenantId: string;
    catalog: { id: string; name: string };
    input: InwardStockBody;
    userId: string;
    serialNumber: string | null;
  }): Promise<StockMovementRecord> {
    const { tenantId, catalog, input, serialNumber } = spec;
    const locationId = input.locationId ?? null;

    const [eqItem] = await tx
      .insert(equipment)
      .values({
        tenantId,
        catalogId: catalog.id,
        locationId,
        ...(serialNumber === null ? {} : { serialNumber }),
        costPrice: input.costPrice ?? '0',
        depositAmount: input.depositAmount ?? '0',
        inventoryStatus: INVENTORY_STATUS.AVAILABLE,
      })
      .returning();

    const detail = serialNumber === null ? 'no serial' : `SN: ${serialNumber}`;
    const [movement] = await tx
      .insert(stockMovements)
      .values({
        tenantId,
        equipmentId: eqItem!.id,
        movementType: STOCK_MOVEMENT_TYPE.INWARD,
        toLocationId: locationId,
        performedBy: spec.userId,
        quantity: 1,
        notes: input.notes ?? `Stock inward: ${catalog.name} (${detail})`,
      })
      .returning();

    return movement!;
  }

  private async resolveTransferSource(tenantId: string, input: TransferStockBody): Promise<{
    targetEquipmentId: string;
    fromLocationId: string | undefined;
  }> {
    if (input.equipmentId !== undefined)
      return { targetEquipmentId: input.equipmentId, fromLocationId: input.fromLocationId };

    if (input.catalogId === undefined)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Either equipmentId or catalogId must be specified');

    const findCond = [
      eq(equipment.tenantId, tenantId),
      eq(equipment.catalogId, input.catalogId),
      eq(equipment.inventoryStatus, INVENTORY_STATUS.AVAILABLE),
    ];
    if (input.fromLocationId !== undefined)
      findCond.push(eq(equipment.locationId, input.fromLocationId));

    const [availableUnit] = await this.db
      .select()
      .from(equipment)
      .where(and(...findCond))
      .limit(1);

    if (!availableUnit)
      throw notFound('Available equipment to transfer');

    return { targetEquipmentId: availableUnit.id, fromLocationId: availableUnit.locationId ?? undefined };
  }

  async transferStock(access: RequestAccess, input: TransferStockBody) {
    const tenantId = access.tenantId;

    await this.assertLocations(access, [input.fromLocationId, input.toLocationId]);
    await this.assertStaffMember(tenantId, input.toStaffId);

    const { targetEquipmentId, fromLocationId } = await this.resolveTransferSource(tenantId, input);

    const [existing] = await this.db
      .select()
      .from(equipment)
      .where(and(eq(equipment.id, targetEquipmentId), eq(equipment.tenantId, tenantId)))
      .limit(1);

    if (!existing) {
      throw notFound('Equipment');
    }

    const nextStatus = input.toStaffId !== undefined ? INVENTORY_STATUS.STAFF_VAN : INVENTORY_STATUS.AVAILABLE;
    const nextLocationId = input.toLocationId ?? (input.toStaffId !== undefined ? null : existing.locationId);

    const { updated, movement } = await this.db.transaction(async (tx) => {
      const [updatedUnit] = await tx
        .update(equipment)
        .set({
          locationId: nextLocationId,
          staffId: input.toStaffId ?? null,
          inventoryStatus: nextStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(equipment.id, existing.id), eq(equipment.tenantId, tenantId)))
        .returning();

      const [movementRow] = await tx
        .insert(stockMovements)
        .values({
          tenantId,
          equipmentId: existing.id,
          movementType: STOCK_MOVEMENT_TYPE.TRANSFER,
          fromLocationId: fromLocationId ?? existing.locationId,
          toLocationId: nextLocationId,
          fromStaffId: existing.staffId,
          toStaffId: input.toStaffId ?? null,
          performedBy: access.userId,
          quantity: input.quantity ?? 1,
          notes: input.notes ?? 'Stock transfer',
        })
        .returning();

      return { updated: updatedUnit!, movement: movementRow! };
    });

    await audit.created(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_STOCK_MOVEMENT,
      entityId: movement.id,
      after: movement,
    });

    return {
      success: true,
      equipmentId: updated.id,
      movementId: movement.id,
    };
  }
}

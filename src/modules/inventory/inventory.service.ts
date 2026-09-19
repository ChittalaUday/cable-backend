import type { Static, TSchema } from 'typebox';
import type { IssuableUnit } from './inventory.repository';
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
import type { EquipmentOwnership } from '@/constants/inventory';
import type { Database } from '@/db/client';
import type { StockMovementRecord } from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { LocationsService } from '@/modules/locations/location.service';
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
import { ERROR_CODES } from '@/errors';
import { badRequest, conflict, forbidden, inUse, notFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { locationScopeFor } from '@/modules/iam/access.service';
import { PERMISSIONS } from '@/security/permissions';
import { InventoryRepository } from './inventory.repository';
import { CreateCatalogItemBody, UpdateCatalogItemBody } from './inventory.schema';

const LOW_STOCK_THRESHOLD = 10;
const DASHBOARD_ROWS = 5;
const MAX_DETAIL_UNITS = 50;
const MAX_LOOKUP_UNITS = 20;
const MAX_LOOKUP_CATALOG = 10;

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
  private readonly repo: InventoryRepository;

  constructor(repoOrDb: InventoryRepository | Database, private readonly locations: LocationsService) {
    this.repo = repoOrDb instanceof InventoryRepository ? repoOrDb : new InventoryRepository(repoOrDb);
  }

  private async assertLocations(access: RequestAccess, ids: readonly (string | undefined)[]): Promise<void> {
    await this.locations.assertWithinReach(
      access,
      PERMISSIONS.INVENTORY_UPDATE,
      ids.filter((id): id is string => id !== undefined),
    );
  }

  /**
   * Issuing and collecting are area work: an engineer may only touch a customer
   * whose service sits inside their grant. An `ALL` grant skips the query.
   */
  private async assertCustomerInReach(access: RequestAccess, customerId: string): Promise<void> {
    const scope = locationScopeFor(access, PERMISSIONS.INVENTORY_ISSUE);

    if (scope.kind === 'ALL_TENANT_LOCATIONS')
      return;

    if (!await this.repo.customerInReach(access.tenantId, customerId, scope.nodeIds))
      throw notFound('Customer');
  }

  private async assertStaffMember(tenantId: string, userId: string | undefined): Promise<void> {
    if (userId === undefined)
      return;

    if (!await this.repo.isStaffMember(tenantId, userId))
      throw notFound('Staff member');
  }

  private canManageCatalog(access: RequestAccess): boolean {
    return access.permissions.has(PERMISSIONS.INVENTORY_MANAGE_CATALOG);
  }

  private stockReach(access: RequestAccess) {
    return this.repo.visibleStock(locationScopeFor(access, PERMISSIONS.INVENTORY_VIEW), access.userId);
  }

  private locationReach(access: RequestAccess) {
    return this.repo.visibleLocations(locationScopeFor(access, PERMISSIONS.INVENTORY_VIEW));
  }

  async getDashboard(access: RequestAccess, locationId?: string): Promise<InventoryDashboardResponse> {
    const { tenantId } = access;
    const reach = this.stockReach(access);

    const locationName = locationId === undefined
      ? null
      : await this.repo.findLocationName(tenantId, locationId);

    const [stats, lowStock, movements] = await Promise.all([
      this.repo.stockCounts(tenantId, reach, locationId),
      this.repo.lowStockItems(tenantId, reach, locationId, LOW_STOCK_THRESHOLD, DASHBOARD_ROWS),
      this.repo.recentMovements(tenantId, reach, DASHBOARD_ROWS),
    ]);

    return {
      locationId: locationId ?? null,
      locationName,
      totalItems: stats.total,
      inStock: stats.inStock,
      issued: stats.issued,
      inTransit: stats.inTransit,
      lowStockItems: lowStock.map(row => ({
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
    const { tenantId } = access;

    const queriedLocationName = query.locationId === undefined
      ? null
      : await this.repo.findLocationName(tenantId, query.locationId);

    const rows = await this.repo.stockList(tenantId, this.stockReach(access), query);

    const result = rows.map(row => ({
      ...row,
      locationId: query.locationId ?? row.aggregatedLocationId,
      locationName: queriedLocationName ?? row.aggregatedLocationName,
    }));

    if (query.status === STOCK_LEVEL_FILTER.IN_STOCK)
      return result.filter(row => row.availableStock > 0);

    if (query.status === STOCK_LEVEL_FILTER.LOW_STOCK)
      return result.filter(row => row.availableStock <= LOW_STOCK_THRESHOLD);

    return result;
  }

  async getItemDetails(access: RequestAccess, id: string): Promise<ItemDetailsResponse> {
    const { tenantId } = access;
    const reach = this.stockReach(access);

    const catalog = await this.repo.findCatalogSummary(tenantId, id);

    if (catalog === null)
      throw notFound('Item not found in catalog');

    const [unitRows, totals] = await Promise.all([
      this.repo.catalogUnits(tenantId, id, reach, MAX_DETAIL_UNITS),
      this.repo.catalogTotals(tenantId, id, reach),
    ]);

    const firstUnitWithLoc = unitRows.find(unit => unit.locationName != null);

    return {
      ...catalog,
      bundleContents: [],
      totalStock: totals.totalStock,
      availableStock: totals.availableStock,
      issuedStock: totals.issuedStock,
      inTransitStock: totals.inTransitStock,
      locationId: firstUnitWithLoc?.locationId ?? null,
      locationName: firstUnitWithLoc?.locationName ?? null,
      units: unitRows.map(unit => ({
        id: unit.id,
        serialNumber: unit.serialNumber,
        vcNumber: unit.vcNumber,
        macAddress: unit.macAddress,
        barcode: unit.barcode,
        inventoryStatus: unit.inventoryStatus,
        locationName: unit.locationName,
        staffName: unit.staffName,
      })),
      bundleComponents: [],
    };
  }

  private async resolveIssuableUnit(spec: {
    tenantId: string;
    input: IssueEquipmentBody;
    installedAt: string | null;
    defaultOwnership: EquipmentOwnership;
  }): Promise<IssuableUnit> {
    const { tenantId, input, installedAt, defaultOwnership } = spec;

    if (input.equipmentId !== undefined) {
      const existingUnit = await this.repo.findUnitRef(tenantId, input.equipmentId);

      if (existingUnit === null)
        throw notFound('Equipment');

      return { ...existingUnit, serialNumber: existingUnit.serialNumber ?? input.serialNumber ?? null };
    }

    const unit = await this.repo.findAvailableUnit(tenantId, input.catalogId, input.serialNumber);
    if (unit !== null)
      return unit;

    return this.repo.createUnit({
      tenantId,
      catalogId: input.catalogId,
      locationId: installedAt,
      serialNumber: input.serialNumber ?? `SN-${Date.now().toString().slice(-6)}`,
      inventoryStatus: INVENTORY_STATUS.AVAILABLE,
      ownershipType: input.ownershipType ?? defaultOwnership,
    });
  }

  private async resolveSubscriptionId(tenantId: string, customer: { id: string; code: string | null }): Promise<string> {
    const existing = await this.repo.findAnySubscriptionId(tenantId, customer.id);
    if (existing !== null)
      return existing;

    const pkg = await this.repo.findAnyPackage(tenantId);
    if (pkg === null)
      throw notFound('No active subscription or package found for customer');

    const locationId = await this.repo.anyLocationId(tenantId);
    if (locationId === null)
      throw notFound('No location found for subscription');

    return this.repo.createSubscription({
      tenantId,
      customerId: customer.id,
      installationLocationId: locationId,
      serviceProviderId: pkg.providerId,
      packageId: pkg.packageId,
      serviceAccountNumber: `SA-${customer.code ?? Date.now().toString().slice(-6)}`,
      status: SUBSCRIPTION_STATUS.ACTIVE,
    });
  }

  async issueEquipment(access: RequestAccess, input: IssueEquipmentBody): Promise<IssueEquipmentResponse> {
    const { tenantId } = access;

    const cust = await this.repo.findCustomer(tenantId, input.customerId);
    if (cust === null)
      throw notFound('Customer not found');

    await this.assertCustomerInReach(access, cust.id);

    const catalog = await this.repo.findCatalogItemById(tenantId, input.catalogId);
    if (catalog === null)
      throw notFound('Catalog item not found');

    if (input.subscriptionId !== undefined && !await this.repo.subscriptionBelongsTo(tenantId, cust.id, input.subscriptionId))
      throw notFound('Subscription');

    // The line is resolved first because the box goes to where the line is
    // installed. Left to itself the unit landed at no location at all, which
    // put it outside the reach of the very engineer who had just fitted it.
    const resolvedSubId = input.subscriptionId ?? await this.resolveSubscriptionId(tenantId, cust);
    const installedAt = await this.repo.subscriptionLocation(tenantId, resolvedSubId);

    const unit = await this.resolveIssuableUnit({
      tenantId,
      input,
      installedAt,
      defaultOwnership: catalog.defaultOwnership,
    });

    const result = await this.repo.inTransaction(async (tx) => {
      await this.repo.updateUnit(tenantId, unit.id, {
        inventoryStatus: INVENTORY_STATUS.ALLOCATED,
        locationId: installedAt ?? unit.locationId,
      }, tx);

      const assignment = await this.repo.createAssignment({
        tenantId,
        customerId: cust.id,
        subscriptionId: resolvedSubId,
        equipmentId: unit.id,
        status: CUSTOMER_EQUIPMENT_STATUS.ACTIVE,
        ownershipType: input.ownershipType ?? catalog.defaultOwnership,
        assignedBy: access.userId,
        notes: input.notes ?? null,
      }, tx);

      await this.repo.createMovement({
        tenantId,
        equipmentId: unit.id,
        movementType: STOCK_MOVEMENT_TYPE.CUSTOMER_ISSUE,
        fromLocationId: unit.locationId,
        toLocationId: installedAt ?? unit.locationId,
        performedBy: access.userId,
        quantity: 1,
        notes: `Issued to customer ${cust.name} (${cust.code ?? ''})`,
      }, tx);

      return assignment;
    });

    await audit.created(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_CUSTOMER_EQUIPMENT,
      entityId: result.id,
      after: result,
    });

    return {
      id: result.id,
      equipmentId: unit.id,
      customerId: cust.id,
      customerName: cust.name ?? 'Customer',
      customerCode: cust.code,
      subscriptionId: result.subscriptionId,
      itemName: catalog.name,
      itemCode: catalog.code,
      serialNumber: unit.serialNumber,
      status: result.status,
      ownershipType: result.ownershipType,
      assignedAt: result.assignedAt.toISOString(),
    };
  }

  async createCatalogItem(access: RequestAccess, input: CreateCatalogItemBody) {
    if (!this.canManageCatalog(access))
      throw forbidden(ERROR_CODES.PERM_DENIED, `Changing the item catalog needs ${PERMISSIONS.INVENTORY_MANAGE_CATALOG} — submit an approval request instead`);

    const created = await this.repo.createCatalogItem(catalogRowFrom(access.tenantId, input));

    await audit.created(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_ITEM,
      entityId: created.id,
      after: created,
    });

    return created;
  }

  async updateCatalogItem(access: RequestAccess, id: string, input: UpdateCatalogItemBody) {
    if (!this.canManageCatalog(access))
      throw forbidden(ERROR_CODES.PERM_DENIED, `Changing the item catalog needs ${PERMISSIONS.INVENTORY_MANAGE_CATALOG} — submit an approval request instead`);

    const { tenantId } = access;
    const existing = await this.repo.findCatalogItemById(tenantId, id);

    if (existing === null)
      throw notFound('Item not found');

    const updated = await this.repo.updateCatalogItem(tenantId, id, input);

    await audit.updated(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_ITEM,
      entityId: id,
      before: existing,
      after: updated!,
    });

    return updated;
  }

  async deleteCatalogItem(access: RequestAccess, id: string) {
    if (!this.canManageCatalog(access))
      throw forbidden(ERROR_CODES.PERM_DENIED, `Changing the item catalog needs ${PERMISSIONS.INVENTORY_MANAGE_CATALOG}`);

    const { tenantId } = access;
    const existing = await this.repo.findCatalogItemById(tenantId, id);

    if (existing === null)
      throw notFound('Item not found');

    // A soft delete raises no foreign key error, so the units still on the
    // books have to be counted here or they are left pointing at nothing.
    const live = await this.repo.countLiveUnits(tenantId, id);

    if (live > 0)
      throw inUse(`${live} unit(s) of this item are still on the books; retire them first`);

    await this.repo.softDeleteCatalogItem(tenantId, id);

    await audit.deleted(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_ITEM,
      entityId: id,
      before: existing,
    });

    return { success: true as const };
  }

  async createApprovalRequest(access: RequestAccess, input: CreateApprovalRequestBody) {
    const created = await this.repo.createApprovalRequest({
      tenantId: access.tenantId,
      requestedBy: access.userId,
      requestType: input.requestType,
      targetItemId: input.targetItemId ?? null,
      proposedData: input.proposedData ?? null,
      reason: input.reason,
      status: INVENTORY_REQUEST_STATUS.PENDING,
    });

    await audit.created(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_APPROVAL_REQUEST,
      entityId: created.id,
      after: created,
    });

    return created;
  }

  async listApprovalRequests(access: RequestAccess) {
    // Without the catalog permission a caller sees only what they asked for.
    const rows = await this.repo.listApprovalRequests(
      access.tenantId,
      this.canManageCatalog(access) ? undefined : access.userId,
    );

    return rows.map(row => ({
      ...row,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async reviewApprovalRequest(access: RequestAccess, id: string, input: ReviewApprovalRequestBody) {
    if (!this.canManageCatalog(access))
      throw forbidden(ERROR_CODES.PERM_DENIED, `Reviewing a change request needs ${PERMISSIONS.INVENTORY_MANAGE_CATALOG}`);

    const { tenantId } = access;
    const req = await this.repo.findApprovalRequest(tenantId, id);

    if (req === null)
      throw notFound('Approval request not found');

    if (req.status !== INVENTORY_REQUEST_STATUS.PENDING)
      throw conflict('This request has already been reviewed');

    if (input.status === INVENTORY_REQUEST_STATUS.APPROVED)
      await this.applyApprovedRequest(access, req);

    const updated = await this.repo.updateApprovalRequest(tenantId, id, {
      status: input.status,
      reviewedBy: access.userId,
      reviewedAt: new Date(),
      reviewNotes: input.reviewNotes ?? null,
    });

    await audit.updated(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_APPROVAL_REQUEST,
      entityId: id,
      before: req,
      after: updated,
    });

    return updated;
  }

  private async applyApprovedRequest(
    access: RequestAccess,
    req: { requestType: string; targetItemId: string | null; proposedData: Record<string, unknown> | null },
  ) {
    const proposed = req.proposedData;

    if (req.requestType === INVENTORY_REQUEST_TYPE.CREATE_ITEM && proposed !== null)
      await this.createCatalogItem(access, parseProposed(CreateCatalogItemBody, proposed));
    else if (req.requestType === INVENTORY_REQUEST_TYPE.UPDATE_ITEM && req.targetItemId !== null && proposed !== null)
      await this.updateCatalogItem(access, req.targetItemId, parseProposed(UpdateCatalogItemBody, proposed));
    else if (req.requestType === INVENTORY_REQUEST_TYPE.DELETE_ITEM && req.targetItemId !== null)
      await this.deleteCatalogItem(access, req.targetItemId);
  }

  async getMovements(access: RequestAccess, limit = 50) {
    const rows = await this.repo.listMovements(access.tenantId, this.stockReach(access), limit);

    return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  async getLocations(access: RequestAccess): Promise<InventoryLocationResponse[]> {
    const rows = await this.repo.locationsWithStock(
      access.tenantId,
      this.stockReach(access),
      this.locationReach(access),
    );

    return rows.map(row => ({ id: row.id, name: row.name, code: row.code, itemCount: row.itemCount }));
  }

  async lookup(access: RequestAccess, queryStr: string): Promise<LookupItemResponse[]> {
    const { tenantId } = access;
    const term = queryStr.trim();

    if (term === '')
      return [];

    const [eqRows, catRows] = await Promise.all([
      this.repo.lookupUnits(tenantId, this.stockReach(access), term, MAX_LOOKUP_UNITS),
      this.repo.lookupCatalog(tenantId, term, MAX_LOOKUP_CATALOG),
    ]);

    return [
      ...eqRows.map((row): LookupItemResponse => ({
        type: 'equipment',
        id: row.id,
        catalogId: row.catalogId!,
        itemName: row.catalogName,
        itemCode: row.catalogCode,
        brand: row.brand,
        model: row.model,
        serialNumber: row.serialNumber,
        barcode: row.barcode,
        vcNumber: row.vcNumber,
        macAddress: row.macAddress,
        inventoryStatus: row.inventoryStatus,
        locationId: row.locationId,
        locationName: row.locationName,
        defaultSalePrice: row.defaultSalePrice,
        defaultDepositAmount: row.defaultDepositAmount,
        availableStock: row.inventoryStatus === INVENTORY_STATUS.AVAILABLE ? 1 : 0,
      })),
      ...catRows.map((row): LookupItemResponse => ({
        type: 'catalog',
        id: row.id,
        catalogId: row.id,
        itemName: row.name,
        itemCode: row.code,
        brand: row.brand,
        model: row.model,
        serialNumber: null,
        barcode: null,
        vcNumber: null,
        macAddress: null,
        inventoryStatus: INVENTORY_STATUS.AVAILABLE,
        locationId: null,
        locationName: null,
        defaultSalePrice: row.defaultSalePrice,
        defaultDepositAmount: row.defaultDepositAmount,
        availableStock: row.availableStock,
      })),
    ];
  }

  async listCustomerEquipment(access: RequestAccess, query: CustomerEquipmentQuery): Promise<CustomerEquipmentItem[]> {
    const rows = await this.repo.listCustomerEquipment(access.tenantId, this.stockReach(access), query);

    return rows.map(row => ({
      ...row,
      customerName: row.customerName ?? 'Customer',
      assignedAt: row.assignedAt.toISOString(),
      returnedAt: row.returnedAt ? row.returnedAt.toISOString() : null,
      returnCondition: row.returnCondition ?? null,
      returnRemarks: row.returnRemarks ?? null,
      returnedToLocationId: row.returnedToLocationId ?? null,
    }));
  }

  async returnCustomerEquipment(access: RequestAccess, input: ReturnCustomerEquipmentBody): Promise<ReturnCustomerEquipmentResponse> {
    const { tenantId } = access;

    const assignment = await this.repo.findAssignment(tenantId, input.customerEquipmentId);

    if (assignment === null)
      throw notFound('Customer equipment assignment not found');

    await this.assertCustomerInReach(access, assignment.customerId);

    if (assignment.status === CUSTOMER_EQUIPMENT_STATUS.RETURNED)
      throw badRequest(ERROR_CODES.RESOURCE_CONFLICT, 'Equipment has already been returned');

    const unit = await this.repo.findUnitById(tenantId, assignment.equipmentId);

    if (unit === null)
      throw notFound('Physical equipment record not found');

    const returnCondition = input.returnCondition ?? EQUIPMENT_RETURN_CONDITION.WORKING;
    const isFaultyOrDamaged = returnCondition === EQUIPMENT_RETURN_CONDITION.FAULTY || returnCondition === EQUIPMENT_RETURN_CONDITION.DAMAGED;
    const nextInventoryStatus = isFaultyOrDamaged ? INVENTORY_STATUS.FAULTY : INVENTORY_STATUS.AVAILABLE;

    const targetLocationId = input.returnedToLocationId ?? unit.locationId;
    if (input.returnedToLocationId !== undefined)
      await this.assertLocations(access, [input.returnedToLocationId]);

    const now = new Date();

    const result = await this.repo.inTransaction(async (tx) => {
      const updatedAssignment = await this.repo.updateAssignment(tenantId, assignment.id, {
        status: CUSTOMER_EQUIPMENT_STATUS.RETURNED,
        returnedAt: now,
        returnCondition,
        collectedBy: access.userId,
        returnedToLocationId: targetLocationId,
        returnRemarks: input.returnRemarks ?? null,
        depositRefundStatus: input.depositRefundStatus ?? 'not_applicable',
        depositDeductionAmount: input.depositDeductionAmount ?? '0',
        notes: input.notes ?? assignment.notes,
      }, tx);

      await this.repo.updateUnit(tenantId, unit.id, {
        inventoryStatus: nextInventoryStatus,
        locationId: targetLocationId,
        staffId: null,
      }, tx);

      await this.repo.createMovement({
        tenantId,
        equipmentId: unit.id,
        movementType: STOCK_MOVEMENT_TYPE.CUSTOMER_RETURN,
        fromLocationId: unit.locationId,
        toLocationId: targetLocationId,
        performedBy: access.userId,
        quantity: 1,
        notes: `Customer return (${returnCondition}): ${input.returnRemarks ?? 'No remarks'}`,
      }, tx);

      return updatedAssignment;
    });

    await audit.updated(this.repo.database, access.audit, {
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
    const { tenantId } = access;

    await this.assertLocations(access, [input.locationId]);

    const catalog = await this.repo.findCatalogItemById(tenantId, input.catalogId);

    if (catalog === null)
      throw notFound('Item in catalog');

    const serials = input.serialNumbers?.filter(Boolean) ?? [];
    const quantity = Math.max(input.quantity ?? serials.length, serials.length, 1);
    const numbers: (string | null)[] = Array.from({ length: quantity }, (_, index) => serials[index] ?? null);

    const insertedMovements: StockMovementRecord[] = [];

    await this.repo.inTransaction(async (tx) => {
      const base = { tenantId, catalog, input, userId: access.userId };

      for (const serialNumber of numbers)
        insertedMovements.push(await this.repo.inwardUnit(tx, { ...base, serialNumber }));
    });

    const primaryMovement = insertedMovements[0];
    if (primaryMovement !== undefined) {
      await audit.created(this.repo.database, access.audit, {
        entityType: AUDIT_ENTITIES.INVENTORY_STOCK_MOVEMENT,
        entityId: primaryMovement.id,
        after: primaryMovement,
      });
    }

    return { success: true, quantity, movementId: primaryMovement?.id ?? null };
  }

  private async resolveTransferSource(tenantId: string, input: TransferStockBody): Promise<{
    targetEquipmentId: string;
    fromLocationId: string | undefined;
  }> {
    if (input.equipmentId !== undefined)
      return { targetEquipmentId: input.equipmentId, fromLocationId: input.fromLocationId };

    if (input.catalogId === undefined)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Either equipmentId or catalogId must be specified');

    const availableUnit = await this.repo.findTransferableUnit(tenantId, input.catalogId, input.fromLocationId);

    if (availableUnit === null)
      throw notFound('Available equipment to transfer');

    return { targetEquipmentId: availableUnit.id, fromLocationId: availableUnit.locationId ?? undefined };
  }

  async transferStock(access: RequestAccess, input: TransferStockBody) {
    const { tenantId } = access;

    await this.assertLocations(access, [input.fromLocationId, input.toLocationId]);
    await this.assertStaffMember(tenantId, input.toStaffId);

    const { targetEquipmentId, fromLocationId } = await this.resolveTransferSource(tenantId, input);

    const existing = await this.repo.findUnitById(tenantId, targetEquipmentId);

    if (existing === null)
      throw notFound('Equipment');

    const nextStatus = input.toStaffId !== undefined ? INVENTORY_STATUS.STAFF_VAN : INVENTORY_STATUS.AVAILABLE;
    const nextLocationId = input.toLocationId ?? (input.toStaffId !== undefined ? null : existing.locationId);

    const { updated, movement } = await this.repo.inTransaction(async (tx) => {
      const updatedUnit = await this.repo.updateUnit(tenantId, existing.id, {
        locationId: nextLocationId,
        staffId: input.toStaffId ?? null,
        inventoryStatus: nextStatus,
      }, tx);

      const movementRow = await this.repo.createMovement({
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
      }, tx);

      return { updated: updatedUnit!, movement: movementRow };
    });

    await audit.created(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.INVENTORY_STOCK_MOVEMENT,
      entityId: movement.id,
      after: movement,
    });

    return { success: true, equipmentId: updated.id, movementId: movement.id };
  }
}

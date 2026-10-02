import type { SQL } from 'drizzle-orm';
import type { HydratedRow, Takings } from './payment.repository';
import type {
  CollectionPage,
  CollectionResponse,
  ListCollectionsQuery,
  RecordEquipmentPaymentBody,
  RecordSubscriptionPaymentBody,
  ReverseCollectionBody,
} from './payment.schema';
import type {
  EquipmentOwnership,
  EquipmentReturnCondition,
  InventoryStatus,
} from '@/constants/inventory';
import type { Database, Transaction } from '@/db/client';
import type { CollectionAccessory, NewCollection } from '@/db/schema';
import type { CollectableLine } from '@/modules/customers/customers.balance';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionScope } from '@/security/permissions';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { COLLECTION_OUTCOME, MAX_COLLECTION_AMOUNT, PAYMENT_METHOD } from '@/constants/billing';
import { TRANSACTION_TYPE } from '@/constants/crm';
import {
  CUSTOMER_EQUIPMENT_STATUS,
  EQUIPMENT_RETURN_CONDITION,
  INVENTORY_STATUS,
  STOCK_MOVEMENT_TYPE,
} from '@/constants/inventory';
import { ERROR_CODES } from '@/errors';
import { badRequest, conflict, forbidden, notFound } from '@/errors/domain-error';
import { isUniqueViolation } from '@/errors/postgres';
import { audit } from '@/modules/audit/audit.service';
import { locationScopeFor, requireScope } from '@/modules/iam/access.service';
import { PERMISSIONS } from '@/security/permissions';
import { PaymentRepository } from './payment.repository';

const ZERO = new Decimal(0);

export interface CollectionAnnouncer {
  (event: {
    tenantId: string;
    collectionId: string;
    customerId: string;
    customerUserId: string | null;
  }): void;
}

function money(value: Decimal | string | number | null | undefined): string {
  return new Decimal(value ?? 0).toFixed(2);
}

function receiptNo(prefix: string, id: string): string {
  return `${prefix}-${id.replaceAll('-', '').slice(0, 10).toUpperCase()}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonical);

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]),
    );
  }

  return value;
}

function requestFingerprint(kind: 'subscription' | 'equipment' | 'reversal', input: object): string {
  return createHash('sha256').update(`${kind}:${JSON.stringify(canonical(input))}`).digest('hex');
}

function encodeCursor(collectedAt: Date, id: string): string {
  return Buffer.from(`${collectedAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { collectedAt: Date; id: string } {
  const [at, id, extra] = Buffer.from(cursor, 'base64url').toString().split('|');
  const collectedAt = at === undefined ? new Date(Number.NaN) : new Date(at);

  if (id === undefined || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) || extra !== undefined || Number.isNaN(collectedAt.getTime()))
    throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Malformed cursor');

  return { collectedAt, id };
}

export class PaymentService {
  private readonly repo: PaymentRepository;

  constructor(
    repoOrDb: PaymentRepository | Database,
    private readonly announce: CollectionAnnouncer = () => {},
  ) {
    this.repo = repoOrDb instanceof PaymentRepository ? repoOrDb : new PaymentRepository(repoOrDb);
  }

  async recordSubscription(access: RequestAccess, input: RecordSubscriptionPaymentBody): Promise<CollectionResponse> {
    const requestHash = requestFingerprint('subscription', input);
    const replay = await this.replayOf(access, input.reference, requestHash);
    if (replay !== null)
      return replay;

    const duesPaid = new Decimal(input.amount);
    const accessoryTotal = (input.accessories ?? []).reduce(
      (total, item) => total.plus(new Decimal(item.unitPrice).mul(item.quantity)),
      ZERO,
    );
    assertCollectionLimit(duesPaid.plus(accessoryTotal));
    const collectedAt = input.collectedAt === undefined ? new Date() : new Date(input.collectedAt);
    const id = randomUUID();

    const created = await this.insertSubscriptionVisit(access, input, { id, duesPaid, collectedAt, requestHash });

    if (created.shouldAnnounce) {
      this.announce({
        tenantId: access.tenantId,
        collectionId: created.id,
        customerId: created.customerId,
        customerUserId: created.customerUserId,
      });
    }

    return this.hydrateOne(created.id, access.tenantId);
  }

  async record(access: RequestAccess, input: RecordSubscriptionPaymentBody): Promise<CollectionResponse> {
    return this.recordSubscription(access, input);
  }

  async recordEquipment(access: RequestAccess, input: RecordEquipmentPaymentBody): Promise<CollectionResponse> {
    const requestHash = requestFingerprint('equipment', input);
    const replay = await this.replayOf(access, input.reference, requestHash);
    if (replay !== null)
      return replay;

    if ((input.customerEquipmentId === undefined) === (input.catalogId === undefined)) {
      throw badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        'Specify exactly one of customerEquipmentId or catalogId',
      );
    }

    const paidAmount = new Decimal(input.amount);
    assertCollectionLimit(paidAmount);
    const collectedAt = input.collectedAt === undefined ? new Date() : new Date(input.collectedAt);
    const id = randomUUID();

    const created = await this.insertEquipmentVisit(access, input, { id, paidAmount, collectedAt, requestHash });

    if (created.shouldAnnounce) {
      this.announce({
        tenantId: access.tenantId,
        collectionId: created.id,
        customerId: created.customerId,
        customerUserId: created.customerUserId,
      });
    }

    return this.hydrateOne(created.id, access.tenantId);
  }

  private async replayOf(access: RequestAccess, reference: string, requestHash: string, tx?: Transaction): Promise<CollectionResponse | null> {
    const existing = await this.repo.findByReference(access.tenantId, reference, tx);

    if (existing === null)
      return null;

    if (existing.collectedBy !== access.userId)
      throw conflict('That reference already belongs to another collector\'s receipt');

    if (existing.requestHash !== null && existing.requestHash !== requestHash)
      throw conflict('That reference was already used for a different payment request');

    return this.hydrateOne(existing.id, access.tenantId, tx);
  }

  private async insertSubscriptionVisit(
    access: RequestAccess,
    input: RecordSubscriptionPaymentBody,
    prepared: { id: string; duesPaid: Decimal; collectedAt: Date; requestHash: string },
  ): Promise<{ id: string; customerId: string; customerUserId: string | null; shouldAnnounce: boolean }> {
    const { id, duesPaid, collectedAt } = prepared;
    const scope = requireScope(access, PERMISSIONS.PAYMENTS_COLLECT);

    try {
      return await this.repo.inTransaction(async (tx) => {
        const customer = await this.repo.lockCustomer(tx, access.tenantId, input.customerId);

        if (customer === null)
          throw notFound('Customer');

        const replay = await this.replayOf(access, input.reference, prepared.requestHash, tx);
        if (replay !== null)
          return { id: replay.id, customerId: replay.customerId, customerUserId: null, shouldAnnounce: false };

        const line = await this.resolveLine(tx, access.tenantId, input);
        await this.assertReaches(tx, scope, access, line?.installationLocationId ?? null);

        const dueAmount = new Decimal(line?.outstandingBalance ?? customer.outstandingBalance);
        const accessoryInputs = input.accessories ?? [];
        const names = await this.repo.accessoryNames(tx, access.tenantId, accessoryInputs.map(item => item.catalogId));
        if (names.size !== new Set(accessoryInputs.map(item => item.catalogId)).size)
          throw notFound('Accessory');

        const accessories = accessoryInputs.map((item): CollectionAccessory => ({
          ...item,
          name: names.get(item.catalogId)!,
          amount: new Decimal(item.unitPrice).mul(item.quantity).toFixed(2),
        }));
        const accessoryAmount = accessories.reduce((total, item) => total.plus(item.amount), ZERO);
        const takings = duesPaid.plus(accessoryAmount);
        const outcome = decideOutcome({ input, duesPaid, dueAmount, takings });

        const transactionId = await this.postTakings(tx, {
          id,
          access,
          line,
          customerId: customer.id,
          dueAmount,
          duesPaid,
          accessoryAmount,
          takings,
          collectedAt,
          remarks: input.notes ?? null,
        });

        const row = await this.repo.insertCollection(tx, collectionRow({
          id,
          access,
          input,
          line,
          customerId: customer.id,
          outcome,
          dueAmount,
          duesPaid,
          accessoryAmount,
          accessories,
          transactionId,
          collectedAt,
          requestHash: prepared.requestHash,
        }));

        await audit.created(tx, access.audit, {
          entityType: AUDIT_ENTITIES.PAYMENT_COLLECTION,
          entityId: id,
          after: row,
        });

        return { ...row, customerUserId: customer.userId, shouldAnnounce: true };
      });
    }
    catch (error) {
      if (!isUniqueViolation(error))
        throw error;

      const winner = await this.replayOf(access, input.reference, prepared.requestHash);

      if (winner === null)
        throw error;

      return { id: winner.id, customerId: winner.customerId, customerUserId: null, shouldAnnounce: false };
    }
  }

  private async resolveReplacementUnit(
    tx: Transaction,
    tenantId: string,
    existingEquipmentId: string,
    replacementEquipmentId?: string,
    replacementSerialNumber?: string,
  ): Promise<{ id: string; serialNumber: string | null }> {
    if (replacementEquipmentId !== undefined) {
      const unit = await this.repo.findEquipmentUnit(tx, tenantId, replacementEquipmentId);
      if (unit === null)
        throw notFound('Replacement equipment unit');
      if (unit.inventoryStatus !== INVENTORY_STATUS.AVAILABLE)
        throw conflict('Replacement equipment unit is not available');
      return unit;
    }

    const oldUnit = await this.repo.findEquipmentUnit(tx, tenantId, existingEquipmentId);
    if (oldUnit === null || oldUnit.catalogId === null)
      throw notFound('Old equipment unit');

    const serialized = replacementSerialNumber === undefined
      ? null
      : await this.repo.findEquipmentBySerial(tx, tenantId, replacementSerialNumber);
    if (serialized !== null && (serialized.catalogId !== oldUnit.catalogId || serialized.inventoryStatus !== INVENTORY_STATUS.AVAILABLE))
      throw conflict('That serial number is already in use or belongs to another catalogue item');

    const existing = serialized ?? await this.repo.findAvailableUnit(tx, tenantId, oldUnit.catalogId);
    if (existing !== null)
      return existing;

    throw conflict('No matching replacement equipment is available in stock');
  }

  private async recordReplacementMovements(
    tx: Transaction,
    access: RequestAccess,
    oldEquipmentId: string,
    newUnit: { id: string; serialNumber: string | null },
    locationId: string | null,
    returnCond: string,
    customerName: string | null,
  ): Promise<void> {
    const replacementLabel = newUnit.serialNumber ?? newUnit.id;
    await this.repo.createStockMovement(tx, {
      tenantId: access.tenantId,
      equipmentId: oldEquipmentId,
      movementType: STOCK_MOVEMENT_TYPE.CUSTOMER_RETURN,
      performedBy: access.userId,
      toLocationId: locationId,
      quantity: 1,
      notes: `Customer return (${returnCond}) replaced by ${replacementLabel}`,
    });

    await this.repo.createStockMovement(tx, {
      tenantId: access.tenantId,
      equipmentId: newUnit.id,
      movementType: STOCK_MOVEMENT_TYPE.CUSTOMER_ISSUE,
      performedBy: access.userId,
      toLocationId: locationId,
      quantity: 1,
      notes: `Issued replacement to customer ${customerName ?? ''}`,
    });
  }

  private async replaceCustomerEquipment(
    tx: Transaction,
    access: RequestAccess,
    customer: { id: string; name: string | null },
    line: CollectableLine | null,
    existingCE: { id: string; equipmentId: string; subscriptionId: string | null; ownershipType: EquipmentOwnership; notes: string | null },
    input: RecordEquipmentPaymentBody,
    collectedAt: Date,
  ): Promise<string> {
    const locationId = line?.installationLocationId ?? null;
    const newUnit = await this.resolveReplacementUnit(
      tx,
      access.tenantId,
      existingCE.equipmentId,
      input.replacementEquipmentId,
      input.replacementSerialNumber,
    );

    const { returnCond, oldUnitStatus } = determineReturnConditionStatus(input.returnCondition);

    await this.repo.updateEquipmentUnit(tx, access.tenantId, existingCE.equipmentId, {
      inventoryStatus: oldUnitStatus,
    });

    await this.repo.updateEquipmentUnit(tx, access.tenantId, newUnit.id, {
      inventoryStatus: INVENTORY_STATUS.ALLOCATED,
      locationId,
    });

    await this.recordReplacementMovements(
      tx,
      access,
      existingCE.equipmentId,
      newUnit,
      locationId,
      returnCond,
      customer.name,
    );

    await this.repo.updateCustomerEquipment(tx, access.tenantId, existingCE.id, {
      status: CUSTOMER_EQUIPMENT_STATUS.REPLACED,
      returnedAt: collectedAt,
      returnCondition: returnCond,
      replacedByEquipmentId: newUnit.id,
      collectedBy: access.userId,
      notes: input.notes ?? existingCE.notes,
    });

    const newAssignment = await this.repo.createCustomerEquipment(tx, {
      tenantId: access.tenantId,
      customerId: customer.id,
      subscriptionId: line?.id ?? existingCE.subscriptionId,
      equipmentId: newUnit.id,
      status: CUSTOMER_EQUIPMENT_STATUS.ACTIVE,
      ownershipType: input.ownershipType ?? existingCE.ownershipType,
      assignedBy: access.userId,
      assignedAt: collectedAt,
      notes: input.notes ?? null,
    });

    return newAssignment.id;
  }

  // Existing id, serial lookup, then stock fallback. Inward stock is the only creator.
  private async resolveOrAddCatalogUnit(
    tx: Transaction,
    tenantId: string,
    catalogId: string,
    equipmentId?: string,
    serialNumber?: string,
  ): Promise<{ id: string; locationId: string | null }> {
    if (equipmentId !== undefined) {
      const unit = await this.repo.findEquipmentUnit(tx, tenantId, equipmentId);
      if (unit === null)
        throw notFound('Equipment');
      if (unit.catalogId !== catalogId || unit.inventoryStatus !== INVENTORY_STATUS.AVAILABLE)
        throw conflict('That equipment unit is not available for this catalogue item');
      return unit;
    }

    if (serialNumber !== undefined) {
      const serialized = await this.repo.findEquipmentBySerial(tx, tenantId, serialNumber);
      if (serialized !== null) {
        if (serialized.catalogId !== catalogId || serialized.inventoryStatus !== INVENTORY_STATUS.AVAILABLE)
          throw conflict('That serial number is already in use');
        return serialized;
      }
    }

    const available = await this.repo.findAvailableUnit(tx, tenantId, catalogId, serialNumber);
    if (available !== null)
      return available;

    throw conflict('No matching equipment is available in stock');
  }

  private async addCustomerEquipment(
    tx: Transaction,
    access: RequestAccess,
    customer: { id: string; name: string | null },
    line: CollectableLine | null,
    input: RecordEquipmentPaymentBody,
    collectedAt: Date,
  ): Promise<string> {
    const catalog = await this.repo.findCatalogItem(tx, access.tenantId, input.catalogId!);
    if (catalog === null)
      throw notFound('Catalog item');

    const locationId = line?.installationLocationId ?? null;
    const unit = await this.resolveOrAddCatalogUnit(
      tx,
      access.tenantId,
      input.catalogId!,
      input.equipmentId,
      input.serialNumber,
    );

    await this.repo.updateEquipmentUnit(tx, access.tenantId, unit.id, {
      inventoryStatus: INVENTORY_STATUS.ALLOCATED,
      locationId: locationId ?? unit.locationId,
    });

    const assignment = await this.repo.createCustomerEquipment(tx, {
      tenantId: access.tenantId,
      customerId: customer.id,
      subscriptionId: line?.id ?? null,
      equipmentId: unit.id,
      status: CUSTOMER_EQUIPMENT_STATUS.ACTIVE,
      ownershipType: input.ownershipType ?? catalog.defaultOwnership,
      assignedBy: access.userId,
      assignedAt: collectedAt,
      notes: input.notes ?? null,
    });

    await this.repo.createStockMovement(tx, {
      tenantId: access.tenantId,
      equipmentId: unit.id,
      movementType: STOCK_MOVEMENT_TYPE.CUSTOMER_ISSUE,
      toLocationId: locationId ?? unit.locationId,
      performedBy: access.userId,
      quantity: 1,
      notes: `Issued equipment to customer ${customer.name ?? ''}`,
    });

    return assignment.id;
  }

  private async resolveTargetEquipmentId(
    tx: Transaction,
    access: RequestAccess,
    customer: { id: string; name: string | null },
    line: CollectableLine | null,
    input: RecordEquipmentPaymentBody,
    collectedAt: Date,
  ): Promise<string> {
    if (input.customerEquipmentId === undefined)
      return this.addCustomerEquipment(tx, access, customer, line, input, collectedAt);

    const existingCE = await this.repo.findCustomerEquipment(tx, access.tenantId, input.customerEquipmentId);
    if (existingCE === null)
      throw notFound('Customer equipment');

    if (existingCE.customerId !== input.customerId) {
      throw badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        'Customer equipment does not belong to this customer',
      );
    }

    if (input.replacementEquipmentId !== undefined || input.replacementSerialNumber !== undefined)
      return this.replaceCustomerEquipment(tx, access, customer, line, existingCE, input, collectedAt);

    const updated = await this.repo.updateCustomerEquipment(tx, access.tenantId, existingCE.id, {
      ...(input.ownershipType !== undefined ? { ownershipType: input.ownershipType } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    return updated.id;
  }

  private async recordEquipmentCollectionRow(
    tx: Transaction,
    access: RequestAccess,
    input: RecordEquipmentPaymentBody,
    prepared: { id: string; paidAmount: Decimal; collectedAt: Date; requestHash: string },
    customer: { id: string },
    targetCustomerEquipmentId: string,
    transactionId: string | null,
  ) {
    const { id, paidAmount, collectedAt } = prepared;
    const isZero = paidAmount.isZero();
    assertValidEquipmentVisit(isZero, input.reason, input.method);

    const outcome = isZero ? COLLECTION_OUTCOME.NONE : COLLECTION_OUTCOME.FULL;
    const row = equipmentCollectionRow({
      id,
      tenantId: access.tenantId,
      customerId: customer.id,
      subscriptionId: null,
      customerEquipmentId: targetCustomerEquipmentId,
      collectedBy: access.userId,
      outcome,
      paidAmount,
      transactionId,
      requestHash: prepared.requestHash,
      input,
      collectedAt,
    });

    return this.repo.insertCollection(tx, row);
  }

  private async insertEquipmentVisit(
    access: RequestAccess,
    input: RecordEquipmentPaymentBody,
    prepared: { id: string; paidAmount: Decimal; collectedAt: Date; requestHash: string },
  ): Promise<{ id: string; customerId: string; customerUserId: string | null; shouldAnnounce: boolean }> {
    const { id, paidAmount, collectedAt } = prepared;
    const scope = requireScope(access, PERMISSIONS.PAYMENTS_COLLECT);

    try {
      return await this.repo.inTransaction(async (tx) => {
        const customer = await this.repo.lockCustomer(tx, access.tenantId, input.customerId);
        if (customer === null)
          throw notFound('Customer');

        const replay = await this.replayOf(access, input.reference, prepared.requestHash, tx);
        if (replay !== null)
          return { id: replay.id, customerId: replay.customerId, customerUserId: null, shouldAnnounce: false };

        const lines = await this.repo.collectableLines(tx, access.tenantId, input.customerId, null);
        if (paidAmount.greaterThan(ZERO) && lines.length === 0) {
          throw badRequest(
            ERROR_CODES.VALIDATION_FAILED,
            'This customer has no subscription to post the payment against',
          );
        }
        const line = await this.firstReachableLine(tx, scope, access, lines);
        if (line !== null && new Decimal(line.outstandingBalance).plus(paidAmount).greaterThan('9999999999.99')) {
          throw badRequest(
            ERROR_CODES.VALIDATION_FAILED,
            'This payment exceeds the supported equipment ledger balance',
          );
        }

        const targetCustomerEquipmentId = await this.resolveTargetEquipmentId(
          tx,
          access,
          customer,
          line,
          input,
          collectedAt,
        );

        const transactionId = line !== null && paidAmount.greaterThan(ZERO)
          ? await this.postEquipmentLedger(tx, access, prepared, customer.id, targetCustomerEquipmentId, line)
          : null;

        const row = await this.recordEquipmentCollectionRow(
          tx,
          access,
          input,
          prepared,
          customer,
          targetCustomerEquipmentId,
          transactionId,
        );

        await audit.created(tx, access.audit, {
          entityType: AUDIT_ENTITIES.PAYMENT_COLLECTION,
          entityId: id,
          after: row,
        });

        return { ...row, customerUserId: customer.userId, shouldAnnounce: true };
      });
    }
    catch (error) {
      if (!isUniqueViolation(error))
        throw error;

      const winner = await this.replayOf(access, input.reference, prepared.requestHash);

      if (winner === null)
        throw conflict('That equipment unit or serial number is already in use');

      return { id: winner.id, customerId: winner.customerId, customerUserId: null, shouldAnnounce: false };
    }
  }

  private async postEquipmentLedger(
    tx: Transaction,
    access: RequestAccess,
    prepared: { id: string; paidAmount: Decimal; collectedAt: Date },
    customerId: string,
    customerEquipmentId: string,
    line: CollectableLine,
  ): Promise<string> {
    const assignment = await this.repo.findCustomerEquipment(tx, access.tenantId, customerEquipmentId);
    if (assignment === null)
      throw notFound('Customer equipment');
    const unit = await this.repo.findEquipmentUnit(tx, access.tenantId, assignment.equipmentId);
    if (unit === null)
      throw notFound('Equipment unit');
    const catalog = unit.catalogId === null ? null : await this.repo.findCatalogItem(tx, access.tenantId, unit.catalogId);
    const remarks = `Equipment: ${catalog?.name ?? 'Equipment'}${unit.serialNumber === null ? '' : ` ${unit.serialNumber}`}`;

    // Charge and receipt cancel each other; equipment money never pays dues.
    return this.postLedger(tx, {
      id: prepared.id,
      access,
      line,
      customerId,
      dueAmount: new Decimal(line.outstandingBalance),
      accessoryAmount: prepared.paidAmount,
      takings: prepared.paidAmount,
      collectedAt: prepared.collectedAt,
      remarks,
      chargeRemarks: remarks,
    });
  }

  async reverse(access: RequestAccess, id: string, input: ReverseCollectionBody): Promise<CollectionResponse> {
    if (requireScope(access, PERMISSIONS.PAYMENTS_UPDATE) !== 'ALL')
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'Reversing a receipt needs payments.update at ALL');

    const requestHash = requestFingerprint('reversal', { id, ...input });
    const replay = await this.replayOf(access, input.reference, requestHash);
    if (replay !== null)
      return replay;

    const reversalId = randomUUID();

    let created: { id: string; customerId: string; customerUserId: string | null; shouldAnnounce: boolean };
    try {
      created = await this.repo.inTransaction(async (tx) => {
        const original = await this.repo.findForReversal(tx, access.tenantId, id);

        if (original === null)
          throw notFound('Collection');

        if (original.outcome === COLLECTION_OUTCOME.REFUND)
          throw conflict('That row is itself a refund');

        if (await this.repo.findReversalOf(tx, access.tenantId, id) !== null) {
          const winner = await this.replayOf(access, input.reference, requestHash, tx);
          if (winner !== null)
            return { id: winner.id, customerId: winner.customerId, customerUserId: null, shouldAnnounce: false };
          throw conflict('That receipt has already been refunded');
        }

        const customer = await this.repo.lockCustomer(tx, access.tenantId, original.customerId);
        if (customer === null)
          throw notFound('Customer');

        const duesPaid = new Decimal(original.duesPaid);
        // An accessory sold on the visit was charged to the account, so undoing
        // the receipt has to take that charge back off too — not just the dues.
        const accessoryAmount = new Decimal(original.accessoryAmount);
        const takings = duesPaid.plus(accessoryAmount);

        const transactionId = await this.unpostTakings(tx, {
          reversalId,
          access,
          original,
          duesPaid,
          accessoryAmount,
          takings,
          reason: input.reason,
        });

        const row = await this.repo.insertCollection(tx, {
          id: reversalId,
          tenantId: access.tenantId,
          customerId: original.customerId,
          subscriptionId: original.subscriptionId,
          customerEquipmentId: original.customerEquipmentId,
          collectedBy: access.userId,
          outcome: COLLECTION_OUTCOME.REFUND,
          method: original.method,
          dueAmount: original.balanceAfter,
          duesPaid: duesPaid.negated().toFixed(2),
          accessoryAmount: accessoryAmount.negated().toFixed(2),
          accessories: original.accessories,
          balanceAfter: new Decimal(original.balanceAfter).plus(duesPaid).toFixed(2),
          transactionId,
          reversesId: original.id,
          reason: input.reason,
          reference: input.reference,
          requestHash,
          collectedAt: new Date(),
        });

        await audit.created(tx, access.audit, {
          entityType: AUDIT_ENTITIES.PAYMENT_COLLECTION,
          entityId: reversalId,
          after: row,
          metadata: { reverses: original.id, reference: original.reference },
        });

        return { ...row, customerUserId: customer.userId, shouldAnnounce: true };
      });
    }
    catch (error) {
      if (!isUniqueViolation(error))
        throw error;

      const winner = await this.replayOf(access, input.reference, requestHash);
      if (winner === null)
        throw conflict('That receipt has already been refunded');
      return winner;
    }

    if (created.shouldAnnounce) {
      this.announce({
        tenantId: access.tenantId,
        collectionId: created.id,
        customerId: created.customerId,
        customerUserId: created.customerUserId,
      });
    }

    return this.hydrateOne(created.id, access.tenantId);
  }

  async list(access: RequestAccess, query: ListCollectionsQuery): Promise<CollectionPage> {
    const reach = this.reachCondition(access);

    if (reach === null)
      return emptyPage(query.limit);

    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const { rows, totals } = await this.repo.listHydrated(access.tenantId, access.userId, query, reach, cursor);

    return pageOf(rows, totals, query.limit);
  }

  async get(access: RequestAccess, id: string): Promise<CollectionResponse> {
    const reach = this.reachCondition(access);

    if (reach === null)
      throw notFound('Collection');

    const row = await this.repo.findHydrated(access.tenantId, id, reach);

    if (row === null)
      throw notFound('Collection');

    return toResponse(row);
  }

  private reachCondition(access: RequestAccess): SQL | null {
    const scope = requireScope(access, PERMISSIONS.PAYMENTS_VIEW);

    return this.repo.reachCondition(
      scope === 'OWN' ? 'OWN' : locationScopeFor(access, PERMISSIONS.PAYMENTS_VIEW),
      access.userId,
    );
  }

  private async resolveLine(
    tx: Transaction,
    tenantId: string,
    input: { customerId: string; subscriptionId?: string | undefined },
  ): Promise<CollectableLine | null> {
    const lines = await this.repo.collectableLines(tx, tenantId, input.customerId, input.subscriptionId ?? null);

    if (input.subscriptionId !== undefined && lines.length === 0)
      throw notFound('Subscription');

    if (input.subscriptionId === undefined && lines.length > 1) {
      throw badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        'This customer has more than one line — name the subscriptionId the payment is for',
      );
    }

    return lines[0] ?? null;
  }

  private async assertReaches(
    tx: Transaction,
    scope: PermissionScope,
    access: RequestAccess,
    locationId: string | null,
  ): Promise<void> {
    if (scope === 'ALL')
      return;

    const reach = locationScopeFor(access, PERMISSIONS.PAYMENTS_COLLECT);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return;

    if (reach.nodeIds.length === 0 || locationId === null)
      throw notFound('Customer');

    if (!await this.repo.nodeUnderGrant(tx, locationId, reach.nodeIds))
      throw notFound('Customer');
  }

  private async firstReachableLine(
    tx: Transaction,
    scope: PermissionScope,
    access: RequestAccess,
    lines: CollectableLine[],
  ): Promise<CollectableLine | null> {
    if (scope === 'ALL')
      return lines[0] ?? null;

    const reach = locationScopeFor(access, PERMISSIONS.PAYMENTS_COLLECT);
    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return lines[0] ?? null;
    if (reach.nodeIds.length === 0)
      throw notFound('Customer');

    for (const line of lines) {
      if (await this.repo.nodeUnderGrant(tx, line.installationLocationId, reach.nodeIds)) {
        return line;
      }
    }

    throw notFound('Customer');
  }

  private async unpostTakings(tx: Transaction, input: {
    reversalId: string;
    access: RequestAccess;
    original: { customerId: string; subscriptionId: string | null; reference: string };
    duesPaid: Decimal;
    accessoryAmount: Decimal;
    takings: Decimal;
    reason: string;
  }): Promise<string | null> {
    const { original } = input;

    if (input.takings.isZero() || original.subscriptionId === null)
      return null;

    const [line] = await this.repo.collectableLines(tx, input.access.tenantId, original.customerId, original.subscriptionId);

    if (line === undefined)
      throw notFound('Subscription');

    const common = {
      tenantId: input.access.tenantId,
      serviceId: line.serviceId,
      customerId: original.customerId,
      subscriptionId: line.id,
      serviceAccountNumber: line.serviceAccountNumber,
      transactionDate: new Date(),
      collectedBy: input.access.userId,
    };

    let running = new Decimal(line.outstandingBalance).plus(input.takings);

    const cashId = await this.repo.insertTransaction(tx, {
      ...common,
      transactionNo: receiptNo('REV', input.reversalId),
      transactionType: TRANSACTION_TYPE.REVERSAL,
      debit: input.takings.toFixed(2),
      credit: '0',
      closingBalance: running.toFixed(2),
      remarks: `Reversal of ${original.reference}: ${input.reason}`,
    });

    if (!input.accessoryAmount.isZero()) {
      running = running.minus(input.accessoryAmount);

      await this.repo.insertTransaction(tx, {
        ...common,
        transactionNo: receiptNo('ADJ', input.reversalId),
        transactionType: TRANSACTION_TYPE.ADJUSTMENT,
        debit: '0',
        credit: input.accessoryAmount.toFixed(2),
        closingBalance: running.toFixed(2),
        remarks: 'Accessories un-charged with the reversal',
      });
    }

    if (!input.duesPaid.isZero())
      await this.repo.applyDuesPayment(tx, input.access.tenantId, original.customerId, line.id, input.duesPaid.negated().toFixed(2));

    return cashId;
  }

  private async postTakings(tx: Transaction, input: {
    id: string;
    access: RequestAccess;
    line: CollectableLine | null;
    customerId: string;
    dueAmount: Decimal;
    duesPaid: Decimal;
    accessoryAmount: Decimal;
    takings: Decimal;
    collectedAt: Date;
    remarks: string | null;
  }): Promise<string | null> {
    if (input.takings.isZero())
      return null;

    const { line } = input;

    if (line === null) {
      throw badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        'There is no active subscription to post this payment against',
      );
    }

    const transactionId = await this.postLedger(tx, { ...input, line });

    if (!input.duesPaid.isZero())
      await this.repo.applyDuesPayment(tx, input.access.tenantId, input.customerId, line.id, input.duesPaid.toFixed(2));

    return transactionId;
  }

  private async postLedger(tx: Transaction, input: {
    id: string;
    access: RequestAccess;
    line: { id: string; serviceId: string; serviceAccountNumber: string };
    customerId: string;
    dueAmount: Decimal;
    accessoryAmount: Decimal;
    takings: Decimal;
    collectedAt: Date;
    remarks: string | null;
    chargeRemarks?: string;
  }): Promise<string> {
    const common = {
      tenantId: input.access.tenantId,
      serviceId: input.line.serviceId,
      customerId: input.customerId,
      subscriptionId: input.line.id,
      serviceAccountNumber: input.line.serviceAccountNumber,
      transactionDate: input.collectedAt,
      collectedBy: input.access.userId,
    };

    let running = input.dueAmount;

    if (!input.accessoryAmount.isZero()) {
      running = running.plus(input.accessoryAmount);

      await this.repo.insertTransaction(tx, {
        ...common,
        transactionNo: receiptNo('ACC', input.id),
        transactionType: TRANSACTION_TYPE.DEDUCTION,
        debit: input.accessoryAmount.toFixed(2),
        credit: '0',
        closingBalance: running.toFixed(2),
        remarks: input.chargeRemarks ?? 'Accessories sold at collection',
      });
    }

    return this.repo.insertTransaction(tx, {
      ...common,
      transactionNo: receiptNo('RCP', input.id),
      transactionType: TRANSACTION_TYPE.DEPOSIT,
      debit: '0',
      credit: input.takings.toFixed(2),
      closingBalance: running.minus(input.takings).toFixed(2),
      remarks: input.remarks,
    });
  }

  private async hydrateOne(id: string, tenantId: string, tx?: Transaction): Promise<CollectionResponse> {
    const row = await this.repo.findHydrated(tenantId, id, undefined, tx);

    if (row === null)
      throw notFound('Collection');

    return toResponse(row);
  }
}

function pageOf(rows: HydratedRow[], summary: Takings | undefined, limit: number): CollectionPage {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map(toResponse),
    total: summary?.receipts ?? 0,
    limit,
    nextCursor: hasMore && last !== undefined ? encodeCursor(new Date(last.collectedAt), last.id) : null,
    totals: {
      duesPaid: money(summary?.duesPaid),
      accessoryAmount: money(summary?.accessoryAmount),
      totalCollected: money(summary?.totalCollected),
      receipts: summary?.receipts ?? 0,
    },
  };
}

function pointFrom(input: {
  latitude?: number;
  longitude?: number;
  gpsAccuracyM?: number;
}): Pick<NewCollection, 'latitude' | 'longitude' | 'gpsAccuracyM'> {
  if (input.latitude === undefined || input.longitude === undefined)
    return { latitude: null, longitude: null, gpsAccuracyM: null };

  return {
    latitude: input.latitude.toFixed(7),
    longitude: input.longitude.toFixed(7),
    gpsAccuracyM: input.gpsAccuracyM === undefined ? null : input.gpsAccuracyM.toFixed(2),
  };
}

function collectionRow(input: {
  id: string;
  access: RequestAccess;
  input: RecordSubscriptionPaymentBody;
  line: CollectableLine | null;
  customerId: string;
  outcome: CollectionResponse['outcome'];
  dueAmount: Decimal;
  duesPaid: Decimal;
  accessoryAmount: Decimal;
  accessories: CollectionAccessory[];
  transactionId: string | null;
  collectedAt: Date;
  requestHash: string;
}): NewCollection {
  const paid = input.outcome !== COLLECTION_OUTCOME.NONE;

  return {
    id: input.id,
    tenantId: input.access.tenantId,
    customerId: input.customerId,
    subscriptionId: input.line?.id ?? null,
    customerEquipmentId: null,
    collectedBy: input.access.userId,
    outcome: input.outcome,
    method: paid ? input.input.method ?? PAYMENT_METHOD.CASH : null,
    dueAmount: input.dueAmount.toFixed(2),
    duesPaid: input.duesPaid.toFixed(2),
    accessoryAmount: input.accessoryAmount.toFixed(2),
    accessories: input.accessories,
    balanceAfter: input.dueAmount.minus(input.duesPaid).toFixed(2),
    transactionId: input.transactionId,
    reason: input.input.reason ?? null,
    notes: input.input.notes ?? null,
    reference: input.input.reference,
    requestHash: input.requestHash,
    collectedAt: input.collectedAt,
    ...pointFrom(input.input),
  };
}

function decideOutcome(input: {
  input: { reason?: string; method?: string };
  duesPaid: Decimal;
  dueAmount: Decimal;
  takings: Decimal;
}): CollectionResponse['outcome'] {
  if (input.takings.isZero()) {
    if (input.input.reason === undefined || input.input.reason.trim() === '')
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'A visit that collected nothing needs a reason');

    return COLLECTION_OUTCOME.NONE;
  }

  if (input.input.method === undefined)
    throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'A payment needs a method');

  return input.duesPaid.gte(input.dueAmount) ? COLLECTION_OUTCOME.FULL : COLLECTION_OUTCOME.PARTIAL;
}

function emptyPage(limit: number): CollectionPage {
  return {
    items: [],
    total: 0,
    limit,
    nextCursor: null,
    totals: { duesPaid: '0.00', accessoryAmount: '0.00', totalCollected: '0.00', receipts: 0 },
  };
}

function determineReturnConditionStatus(condition?: EquipmentReturnCondition): {
  returnCond: EquipmentReturnCondition;
  oldUnitStatus: InventoryStatus;
} {
  const returnCond = condition ?? EQUIPMENT_RETURN_CONDITION.WORKING;
  const isFaultyOrDamaged = returnCond === EQUIPMENT_RETURN_CONDITION.FAULTY || returnCond === EQUIPMENT_RETURN_CONDITION.DAMAGED;
  return {
    returnCond,
    oldUnitStatus: isFaultyOrDamaged ? INVENTORY_STATUS.FAULTY : INVENTORY_STATUS.AVAILABLE,
  };
}

function assertCollectionLimit(amount: Decimal): void {
  if (amount.greaterThan(MAX_COLLECTION_AMOUNT))
    throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'The total payment cannot exceed ₹99,000');
}

function assertValidEquipmentVisit(isZero: boolean, reason?: string, method?: string): void {
  if (isZero) {
    if (reason === undefined || reason.trim() === '')
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'A visit that collected nothing needs a reason');
    return;
  }
  if (method === undefined)
    throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'A payment needs a method');
}

function equipmentCollectionRow(input: {
  id: string;
  tenantId: string;
  customerId: string;
  subscriptionId: string | null;
  customerEquipmentId: string;
  collectedBy: string;
  outcome: CollectionResponse['outcome'];
  paidAmount: Decimal;
  transactionId: string | null;
  input: RecordEquipmentPaymentBody;
  collectedAt: Date;
  requestHash: string;
}): NewCollection {
  const isZero = input.paidAmount.isZero();
  return {
    id: input.id,
    tenantId: input.tenantId,
    customerId: input.customerId,
    subscriptionId: input.subscriptionId,
    customerEquipmentId: input.customerEquipmentId,
    collectedBy: input.collectedBy,
    outcome: input.outcome,
    method: !isZero ? (input.input.method ?? PAYMENT_METHOD.CASH) : null,
    dueAmount: input.paidAmount.toFixed(2),
    duesPaid: input.paidAmount.toFixed(2),
    accessoryAmount: '0.00',
    accessories: [],
    balanceAfter: '0.00',
    transactionId: input.transactionId,
    reason: input.input.reason ?? null,
    notes: input.input.notes ?? null,
    reference: input.input.reference,
    requestHash: input.requestHash,
    collectedAt: input.collectedAt,
    ...pointFrom(input.input),
  };
}

function toResponse(row: HydratedRow): CollectionResponse {
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customerName,
    customerCode: row.customerCode,
    subscriptionId: row.subscriptionId,
    customerEquipmentId: row.customerEquipmentId ?? null,
    equipment: row.equipmentName !== null
      ? {
          itemName: row.equipmentName,
          itemCode: row.equipmentItemCode ?? null,
          serialNumber: row.equipmentSerialNumber ?? null,
          brand: row.equipmentBrand ?? null,
          model: row.equipmentModel ?? null,
        }
      : null,
    serviceAccountNumber: row.serviceAccountNumber,
    locationId: row.locationId,
    locationPath: row.locationPath,
    collectedBy: row.collectedBy,
    collectorName: row.collectorName,
    outcome: row.outcome,
    method: row.method,
    dueAmount: money(row.dueAmount),
    duesPaid: money(row.duesPaid),
    accessoryAmount: money(row.accessoryAmount),
    totalCollected: money(row.totalCollected),
    balanceAfter: money(row.balanceAfter),
    transactionId: row.transactionId,
    accessories: row.accessories ?? [],
    reversesId: row.reversesId,
    reversedById: row.reversedById,
    reason: row.reason,
    notes: row.notes,
    reference: row.reference,
    latitude: row.latitude,
    longitude: row.longitude,
    gpsAccuracyM: row.gpsAccuracyM,
    collectedAt: new Date(row.collectedAt).toISOString(),
  };
}

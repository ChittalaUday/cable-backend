import type { SQL } from 'drizzle-orm';
import type {
  CollectionPage,
  CollectionResponse,
  ListCollectionsQuery,
  RecordCollectionBody,
  ReverseCollectionBody,
} from './payment.schema';
import type { Database, Transaction } from '@/db/client';
import type { NewCollection } from '@/db/schema';
import type { CollectableLine } from '@/modules/customers/customers.balance';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionScope } from '@/security/permissions';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { and, eq, sql } from 'drizzle-orm';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { COLLECTION_OUTCOME, PAYMENT_METHOD } from '@/constants/billing';
import { TRANSACTION_TYPE } from '@/constants/crm';
import { accountTransactions, collections, pointOf } from '@/db/schema';
import { ERROR_CODES } from '@/errors';
import { badRequest, conflict, forbidden, notFound } from '@/errors/domain-error';
import { isUniqueViolation } from '@/errors/postgres';
import { audit } from '@/modules/audit/audit.service';
import {
  applyDuesPayment,
  findCollectableLine,
  lockCustomer,
} from '@/modules/customers/customers.balance';
import { locationScopeFor, requireScope } from '@/modules/iam/access.service';
import { underAnyGrant, withinGrantedSubtree } from '@/security/location-scope';
import { PERMISSIONS } from '@/security/permissions';

const ZERO = new Decimal(0);

interface CollectionAccessory {
  catalogId: string;
  name: string;
  quantity: number;
  unitPrice: string;
  amount: string;
}

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

function encodeCursor(collectedAt: Date, id: string): string {
  return Buffer.from(`${collectedAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { collectedAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const collectedAt = at === undefined ? new Date(Number.NaN) : new Date(at);

  if (id === undefined || Number.isNaN(collectedAt.getTime()))
    throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Malformed cursor');

  return { collectedAt, id };
}

interface Takings extends Record<string, unknown> {
  duesPaid: string;
  accessoryAmount: string;
  totalCollected: string;
  receipts: number;
}

interface HydratedRow extends Record<string, unknown> {
  id: string;
  customerId: string;
  customerName: string | null;
  customerCode: string | null;
  subscriptionId: string | null;
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

export class PaymentService {
  constructor(
    private readonly db: Database,
    private readonly announce: CollectionAnnouncer = () => {},
  ) {}

  async record(access: RequestAccess, input: RecordCollectionBody): Promise<CollectionResponse> {
    const replay = await this.replayOf(access, input.reference);
    if (replay !== null)
      return replay;

    const duesPaid = new Decimal(input.amount);
    const collectedAt = input.collectedAt === undefined ? new Date() : new Date(input.collectedAt);
    const id = randomUUID();

    const created = await this.insertVisit(access, input, { id, duesPaid, collectedAt });

    this.announce({
      tenantId: access.tenantId,
      collectionId: created.id,
      customerId: created.customerId,
      customerUserId: created.customerUserId,
    });

    return this.hydrateOne(created.id, access.tenantId);
  }

  private async replayOf(access: RequestAccess, reference: string): Promise<CollectionResponse | null> {
    const existing = await this.findByReference(access.tenantId, reference);

    if (existing === null)
      return null;

    if (existing.collectedBy !== access.userId)
      throw conflict('That reference already belongs to another collector\'s receipt');

    return this.hydrateOne(existing.id, access.tenantId);
  }

  private async insertVisit(
    access: RequestAccess,
    input: RecordCollectionBody,
    prepared: { id: string; duesPaid: Decimal; collectedAt: Date },
  ): Promise<{ id: string; customerId: string; customerUserId: string | null }> {
    const { id, duesPaid, collectedAt } = prepared;
    const scope = requireScope(access, PERMISSIONS.PAYMENTS_COLLECT);

    try {
      return await this.db.transaction(async (tx) => {
        const customer = await lockCustomer(tx, access.tenantId, input.customerId);

        if (customer === null)
          throw notFound('Customer');

        const line = await this.resolveLine(tx, access.tenantId, input);
        await this.assertReaches(tx, scope, access, line?.installationLocationId ?? null);

        const accessories = await this.priceAccessories(tx, access.tenantId, input.accessories ?? []);
        const accessoryAmount = accessories.reduce((total, item) => total.plus(item.amount), ZERO);
        const takings = duesPaid.plus(accessoryAmount);

        const dueAmount = new Decimal(line?.outstandingBalance ?? customer.outstandingBalance);
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

        const [row] = await tx.insert(collections).values(collectionRow({
          id,
          access,
          input,
          line,
          customerId: customer.id,
          outcome,
          dueAmount,
          duesPaid,
          transactionId,
          collectedAt,
        })).returning();

        await audit.created(tx, access.audit, {
          entityType: AUDIT_ENTITIES.PAYMENT_COLLECTION,
          entityId: id,
          after: row!,
        });

        return { ...row!, customerUserId: customer.userId };
      });
    }
    catch (error) {
      if (!isUniqueViolation(error))
        throw error;

      const winner = await this.replayOf(access, input.reference);

      if (winner === null)
        throw error;

      return { id: winner.id, customerId: winner.customerId, customerUserId: null };
    }
  }

  async reverse(access: RequestAccess, id: string, input: ReverseCollectionBody): Promise<CollectionResponse> {
    if (requireScope(access, PERMISSIONS.PAYMENTS_UPDATE) !== 'ALL')
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'Reversing a receipt needs payments.update at ALL');

    const replay = await this.replayOf(access, input.reference);
    if (replay !== null)
      return replay;

    const reversalId = randomUUID();

    const created = await this.db.transaction(async (tx) => {
      const [original] = await tx.select().from(collections).where(and(eq(collections.id, id), eq(collections.tenantId, access.tenantId)));

      if (original === undefined)
        throw notFound('Collection');

      if (original.outcome === COLLECTION_OUTCOME.REFUND)
        throw conflict('That row is itself a refund');

      const [already] = await tx.select({ id: collections.id }).from(collections).where(and(eq(collections.reversesId, id), eq(collections.tenantId, access.tenantId)));

      if (already !== undefined)
        throw conflict('That receipt has already been refunded');

      const customer = await lockCustomer(tx, access.tenantId, original.customerId);
      if (customer === null)
        throw notFound('Customer');

      const duesPaid = new Decimal(original.duesPaid);
      const takings = duesPaid;

      const transactionId = await this.unpostTakings(tx, {
        reversalId,
        access,
        original,
        duesPaid,
        accessoryAmount: ZERO,
        takings,
        reason: input.reason,
      });

      const [row] = await tx.insert(collections).values({
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
        balanceAfter: new Decimal(original.balanceAfter).plus(duesPaid).toFixed(2),
        transactionId,
        reversesId: original.id,
        reason: input.reason,
        reference: input.reference,
        collectedAt: new Date(),
      }).returning();

      await audit.created(tx, access.audit, {
        entityType: AUDIT_ENTITIES.PAYMENT_COLLECTION,
        entityId: reversalId,
        after: row!,
        metadata: { reverses: original.id, reference: original.reference },
      });

      return { ...row!, customerUserId: customer.userId };
    });

    this.announce({
      tenantId: access.tenantId,
      collectionId: created.id,
      customerId: created.customerId,
      customerUserId: created.customerUserId,
    });

    return this.hydrateOne(created.id, access.tenantId);
  }

  async list(access: RequestAccess, query: ListCollectionsQuery): Promise<CollectionPage> {
    const reach = this.reachCondition(access);

    if (reach === null)
      return emptyPage(query.limit);

    const where = sql.join(filtersFor(access, query, reach), sql` AND `);
    const paged = query.cursor === undefined ? where : sql`${where} AND ${afterCursor(query.cursor)}`;

    const [rows, totals] = await Promise.all([
      this.db.execute<HydratedRow>(sql`
        ${this.selectCollections()}
        WHERE ${paged}
        ORDER BY c.collected_at DESC, c.id DESC
        LIMIT ${query.limit + 1}
      `),
      this.db.execute<Takings>(sql`
        SELECT coalesce(sum(c.dues_paid), 0) "duesPaid",
               '0.00'::numeric(12, 2) "accessoryAmount",
               coalesce(sum(c.total_collected), 0) "totalCollected",
               count(*)::int "receipts"
        FROM billing.collections c
        LEFT JOIN crm.subscriptions s ON s.id = c.subscription_id
        WHERE ${where}
      `),
    ]);

    return pageOf(rows.rows, totals.rows[0], query.limit);
  }

  async get(access: RequestAccess, id: string): Promise<CollectionResponse> {
    const reach = this.reachCondition(access);

    if (reach === null)
      throw notFound('Collection');

    const { rows } = await this.db.execute<HydratedRow>(sql`
      ${this.selectCollections()}
      WHERE c.tenant_id = ${access.tenantId} AND c.id = ${id} AND ${reach}
    `);

    if (rows[0] === undefined)
      throw notFound('Collection');

    return toResponse(rows[0]);
  }

  private reachCondition(access: RequestAccess): SQL | null {
    const scope = requireScope(access, PERMISSIONS.PAYMENTS_VIEW);

    if (scope === 'OWN') {
      return sql`EXISTS (
        SELECT 1 FROM crm.customers own
        WHERE own.id = c.customer_id AND own.user_id = ${access.userId}
      )`;
    }

    const reach = locationScopeFor(access, PERMISSIONS.PAYMENTS_VIEW);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return sql`true`;

    if (reach.nodeIds.length === 0)
      return null;

    return withinGrantedSubtree(sql`s.installation_location_id`, reach.nodeIds);
  }

  private async resolveLine(
    tx: Transaction,
    tenantId: string,
    input: RecordCollectionBody,
  ): Promise<CollectableLine | null> {
    const lines = await findCollectableLine(tx, tenantId, input.customerId, input.subscriptionId ?? null);

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

    const { rows } = await tx.execute<{ reached: boolean }>(sql`
      SELECT ${underAnyGrant(sql`${locationId}::uuid`, reach.nodeIds)} AS reached
    `);

    if (rows[0]?.reached !== true)
      throw notFound('Customer');
  }

  private async priceAccessories(
    tx: Transaction,
    tenantId: string,
    lines: readonly { catalogId: string; quantity: number; unitPrice: string }[],
  ): Promise<CollectionAccessory[]> {
    if (lines.length === 0)
      return [];

    const ids = [...new Set(lines.map(line => line.catalogId))];
    const { rows } = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM inventory.item_catalog
      WHERE tenant_id = ${tenantId} AND id = ANY(${sql.param(ids)}::uuid[])
        AND deleted_at IS NULL
    `);

    const known = new Map(rows.map(row => [row.id, row.name]));

    return lines.map((line) => {
      const name = known.get(line.catalogId);

      if (name === undefined)
        throw notFound('Accessory');

      return {
        catalogId: line.catalogId,
        name,
        quantity: line.quantity,
        unitPrice: money(line.unitPrice),
        amount: new Decimal(line.unitPrice).times(line.quantity).toFixed(2),
      };
    });
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

    const [line] = await findCollectableLine(tx, input.access.tenantId, original.customerId, original.subscriptionId);

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

    const [cash] = await tx.insert(accountTransactions).values({
      ...common,
      transactionNo: receiptNo('REV', input.reversalId),
      transactionType: TRANSACTION_TYPE.REVERSAL,
      debit: input.takings.toFixed(2),
      credit: '0',
      closingBalance: running.toFixed(2),
      remarks: `Reversal of ${original.reference}: ${input.reason}`,
    }).returning();

    if (!input.accessoryAmount.isZero()) {
      running = running.minus(input.accessoryAmount);

      await tx.insert(accountTransactions).values({
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
      await applyDuesPayment(tx, input.access.tenantId, original.customerId, line.id, input.duesPaid.negated().toFixed(2));

    return cash!.id;
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
      await applyDuesPayment(tx, input.access.tenantId, input.customerId, line.id, input.duesPaid.toFixed(2));

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

      await tx.insert(accountTransactions).values({
        ...common,
        transactionNo: receiptNo('ACC', input.id),
        transactionType: TRANSACTION_TYPE.DEDUCTION,
        debit: input.accessoryAmount.toFixed(2),
        credit: '0',
        closingBalance: running.toFixed(2),
        remarks: 'Accessories sold at collection',
      });
    }

    const [row] = await tx.insert(accountTransactions).values({
      ...common,
      transactionNo: receiptNo('RCP', input.id),
      transactionType: TRANSACTION_TYPE.DEPOSIT,
      debit: '0',
      credit: input.takings.toFixed(2),
      closingBalance: running.minus(input.takings).toFixed(2),
      remarks: input.remarks,
    }).returning();

    return row!.id;
  }

  private async findByReference(tenantId: string, reference: string): Promise<{ id: string; collectedBy: string } | null> {
    const [row] = await this.db
      .select({ id: collections.id, collectedBy: collections.collectedBy })
      .from(collections)
      .where(and(eq(collections.tenantId, tenantId), eq(collections.reference, reference)));

    return row ?? null;
  }

  private selectCollections(): SQL {
    return sql`
      SELECT c.id,
             c.customer_id "customerId",
             coalesce(u.name, cust.name) "customerName",
             cust.customer_code "customerCode",
             c.subscription_id "subscriptionId",
             s.service_account_number "serviceAccountNumber",
             s.installation_location_id "locationId",
             lp.path "locationPath",
             c.collected_by "collectedBy",
             collector.name "collectorName",
             c.outcome, c.method,
             c.due_amount "dueAmount",
             c.dues_paid "duesPaid",
             '0.00'::numeric(12, 2) "accessoryAmount",
             c.total_collected "totalCollected",
             c.balance_after "balanceAfter",
             '[]'::jsonb "accessories",
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
    `;
  }

  private async hydrateOne(id: string, tenantId: string): Promise<CollectionResponse> {
    const { rows } = await this.db.execute<HydratedRow>(sql`
      ${this.selectCollections()}
      WHERE c.tenant_id = ${tenantId} AND c.id = ${id}
    `);

    if (rows[0] === undefined)
      throw notFound('Collection');

    return toResponse(rows[0]);
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

function filtersFor(access: RequestAccess, query: ListCollectionsQuery, reach: SQL): SQL[] {
  const filters: SQL[] = [sql`c.tenant_id = ${access.tenantId}`, reach];

  if (query.customerId !== undefined)
    filters.push(sql`c.customer_id = ${query.customerId}`);

  if (query.collectedBy !== undefined)
    filters.push(sql`c.collected_by = ${query.collectedBy === 'me' ? access.userId : query.collectedBy}`);

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

function afterCursor(cursor: string): SQL {
  const { collectedAt, id } = decodeCursor(cursor);

  return sql`(c.collected_at, c.id) < (${collectedAt}, ${id}::uuid)`;
}

function pointFrom(input: RecordCollectionBody): Pick<NewCollection, 'latitude' | 'longitude' | 'gpsAccuracyM'> {
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
  input: RecordCollectionBody;
  line: CollectableLine | null;
  customerId: string;
  outcome: CollectionResponse['outcome'];
  dueAmount: Decimal;
  duesPaid: Decimal;
  transactionId: string | null;
  collectedAt: Date;
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
    balanceAfter: input.dueAmount.minus(input.duesPaid).toFixed(2),
    transactionId: input.transactionId,
    reason: input.input.reason ?? null,
    notes: input.input.notes ?? null,
    reference: input.input.reference,
    collectedAt: input.collectedAt,
    ...pointFrom(input.input),
  };
}

function decideOutcome(input: {
  input: RecordCollectionBody;
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

function toResponse(row: HydratedRow): CollectionResponse {
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customerName,
    customerCode: row.customerCode,
    subscriptionId: row.subscriptionId,
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

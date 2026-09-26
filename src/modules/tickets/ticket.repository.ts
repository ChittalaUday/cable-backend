import type { SQL } from 'drizzle-orm';
import type { Ticket as TicketRow } from './ticket.schema';
import type { Database, Transaction } from '@/db/client';
import type { NewTicket } from '@/db/schema';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  customers,
  locationPaths,
  packages,
  subscriptions,
  tickets,
  users,
} from '@/db/schema';

/** The joined row every ticket read returns, before it is shaped for the wire. */
const SELECTION = {
  ticket: tickets,
  customerName: customers.name,
  customerPhone: customers.phone,
  customerCode: customers.customerCode,
  accountNumber: subscriptions.serviceAccountNumber,
  packageName: packages.name,
  locationPath: locationPaths.path,
  assigneeName: users.name,
};

export class TicketRepository {
  constructor(private readonly db: Database) {}

  async inTransaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(run);
  }

  /** The tenant's next ticket handle, taken under the tenant row's own lock. */
  async nextTicketNo(tx: Transaction, tenantId: string): Promise<string> {
    const { rows } = await tx.execute<{ no: string }>(
      sql`SELECT crm.next_ticket_no(${tenantId}) AS no`,
    );

    return rows[0]!.no;
  }

  async insert(tx: Transaction, values: NewTicket) {
    const [row] = await tx.insert(tickets).values(values).returning();

    return row!;
  }

  /** Always writes: callers have already read the row inside the same request. */
  async update(tx: Transaction, tenantId: string, id: string, patch: Partial<NewTicket>) {
    const [row] = await tx
      .update(tickets)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id)))
      .returning();

    return row!;
  }

  /** The raw row, for a service that needs to judge reach before it answers. */
  async findRaw(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id), isNull(tickets.deletedAt)))
      .limit(1);

    return row ?? null;
  }

  async findOne(tenantId: string, id: string): Promise<TicketRow | null> {
    const [row] = await this.baseQuery()
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id), isNull(tickets.deletedAt)))
      .limit(1);

    return row === undefined ? null : shape(row);
  }

  async list(where: SQL, limit: number, offset: number): Promise<{ items: TicketRow[]; total: number }> {
    const [rows, [totals]] = await Promise.all([
      this.baseQuery().where(where).orderBy(desc(tickets.createdAt), desc(tickets.id)).limit(limit).offset(offset),
      this.db.select({ value: count() }).from(tickets).where(where),
    ]);

    return { items: rows.map(shape), total: totals?.value ?? 0 };
  }

  /** The line a ticket is raised against, with where it is fitted. */
  async findLine(tenantId: string, customerId: string, subscriptionId: string) {
    const [row] = await this.db
      .select({
        id: subscriptions.id,
        locationId: subscriptions.installationLocationId,
      })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.customerId, customerId),
        eq(subscriptions.id, subscriptionId),
        isNull(subscriptions.deletedAt),
      ))
      .limit(1);

    return row ?? null;
  }

  /** Any of the customer's lines, so a ticket raised on the account still lands in an area. */
  async anyLineOf(tenantId: string, customerId: string) {
    const [row] = await this.db
      .select({ id: subscriptions.id, locationId: subscriptions.installationLocationId })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.customerId, customerId),
        isNull(subscriptions.deletedAt),
      ))
      .orderBy(subscriptions.createdAt)
      .limit(1);

    return row ?? null;
  }

  /** `ownedBy` narrows it to that user's own record — what an OWN-scoped caller may reach. */
  async customerExists(tenantId: string, customerId: string, ownedBy?: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(
        eq(customers.tenantId, tenantId),
        eq(customers.id, customerId),
        isNull(customers.deletedAt),
        ownedBy === undefined ? undefined : eq(customers.userId, ownedBy),
      ))
      .limit(1);

    return row !== undefined;
  }

  /** Whether a user is a live member of this tenant — who a ticket may be handed to. */
  async isTenantMember(tenantId: string, userId: string): Promise<boolean> {
    const { rows } = await this.db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM tenancy.tenant_memberships m
        WHERE m.user_id = ${userId} AND m.tenant_id = ${tenantId}
          AND m.status = 'active' AND m.deleted_at IS NULL
      ) AS ok
    `);

    return rows[0]?.ok === true;
  }

  private baseQuery() {
    return this.db
      .select(SELECTION)
      .from(tickets)
      .innerJoin(customers, eq(customers.id, tickets.customerId))
      .leftJoin(subscriptions, eq(subscriptions.id, tickets.subscriptionId))
      .leftJoin(packages, eq(packages.id, subscriptions.packageId))
      .leftJoin(locationPaths, eq(locationPaths.id, tickets.locationId))
      .leftJoin(users, eq(users.id, tickets.assignedTo))
      .$dynamic();
  }
}

interface JoinedRow {
  ticket: typeof tickets.$inferSelect;
  customerName: string | null;
  customerPhone: string | null;
  customerCode: string | null;
  accountNumber: string | null;
  packageName: string | null;
  locationPath: string | null;
  assigneeName: string | null;
}

function shape(row: JoinedRow): TicketRow {
  const ticket = row.ticket;

  return {
    id: ticket.id,
    ticketNo: ticket.ticketNo,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    subject: ticket.subject,
    description: ticket.description,
    customer: {
      id: ticket.customerId,
      name: row.customerName,
      phone: row.customerPhone,
      customerCode: row.customerCode,
    },
    subscription: ticket.subscriptionId === null || row.accountNumber === null
      ? null
      : {
          id: ticket.subscriptionId,
          serviceAccountNumber: row.accountNumber,
          packageName: row.packageName ?? 'Package',
        },
    locationId: ticket.locationId,
    locationPath: row.locationPath,
    assignedTo: ticket.assignedTo === null ? null : { id: ticket.assignedTo, name: row.assigneeName },
    resolution: ticket.resolution,
    resolvedAt: ticket.resolvedAt === null ? null : ticket.resolvedAt.toISOString(),
    createdBy: ticket.createdBy,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

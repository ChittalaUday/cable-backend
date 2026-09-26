import type {
  AssignTicketBody,
  CreateTicketBody,
  ListTicketsQuery,
  Ticket,
  UpdateTicketBody,
} from './ticket.schema';
import type { Database } from '@/db/client';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionKey } from '@/security/permissions';
import type { Page } from '@/utils/pagination';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { TICKET_CLOSED_STATUSES } from '@/constants/crm';
import { tickets } from '@/db/schema';
import { ERROR_CODES } from '@/errors';
import { badRequest, notFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { requireScope } from '@/modules/iam/access.service';
import { withinGrantedSubtree } from '@/security/location-scope';
import { PERMISSIONS } from '@/security/permissions';
import { TicketRepository } from './ticket.repository';

/** Statuses a ticket is no longer being worked on in. */
const SETTLED: readonly string[] = TICKET_CLOSED_STATUSES;

export class TicketService {
  private readonly repo: TicketRepository;

  constructor(repoOrDb: TicketRepository | Database) {
    this.repo = repoOrDb instanceof TicketRepository ? repoOrDb : new TicketRepository(repoOrDb);
  }

  async list(access: RequestAccess, query: ListTicketsQuery): Promise<Page<Ticket>> {
    const filters = [
      eq(tickets.tenantId, access.tenantId),
      isNull(tickets.deletedAt),
      this.reach(access, PERMISSIONS.TICKETS_VIEW),
    ];

    if (query.status !== undefined)
      filters.push(eq(tickets.status, query.status));

    // "Open" to an operator means anything still on somebody's plate, which is
    // every status except the three a ticket finishes in.
    if (query.openOnly === true)
      filters.push(sql`${tickets.status} <> ALL(${sql.param([...SETTLED])}::text[])`);

    if (query.priority !== undefined)
      filters.push(eq(tickets.priority, query.priority));

    if (query.category !== undefined)
      filters.push(eq(tickets.category, query.category));

    if (query.customerId !== undefined)
      filters.push(eq(tickets.customerId, query.customerId));

    if (query.assignedTo !== undefined)
      filters.push(eq(tickets.assignedTo, query.assignedTo === 'me' ? access.userId : query.assignedTo));

    if (query.q !== undefined) {
      const needle = `%${query.q.trim()}%`;
      filters.push(or(sql`${tickets.ticketNo} ILIKE ${needle}`, sql`${tickets.subject} ILIKE ${needle}`)!);
    }

    const { items, total } = await this.repo.list(
      and(...filters)!,
      query.limit,
      (query.page - 1) * query.limit,
    );

    return { items, total, page: query.page, limit: query.limit };
  }

  async detail(access: RequestAccess, id: string): Promise<Ticket> {
    // Read it back through the same reach the list uses, so a ticket outside
    // the caller's areas is a 404 here too rather than a 403 that confirms it.
    const found = await this.repo.list(
      and(
        eq(tickets.tenantId, access.tenantId),
        eq(tickets.id, id),
        isNull(tickets.deletedAt),
        this.reach(access, PERMISSIONS.TICKETS_VIEW),
      )!,
      1,
      0,
    );

    const ticket = found.items[0];

    if (ticket === undefined)
      throw notFound('Ticket');

    return ticket;
  }

  async create(access: RequestAccess, input: CreateTicketBody): Promise<Ticket> {
    const scope = requireScope(access, PERMISSIONS.TICKETS_CREATE);

    // A subscriber complains about their own account and nobody else's. Without
    // this, OWN scope checked only that the customer belonged to the tenant, so
    // any signed-in customer could file a fault against a neighbour's line —
    // and that ticket then reaches a real engineer. 404, not 403: whose id it
    // is is not something the caller should learn either.
    if (!await this.repo.customerExists(access.tenantId, input.customerId, scope === 'OWN' ? access.userId : undefined))
      throw notFound('Customer');

    // Where the complaint lands. Taken off the named line, or off the
    // customer's first one — a ticket with no area is one no field engineer
    // ever sees, because every scoped list filters on it.
    const line = input.subscriptionId === undefined
      ? await this.repo.anyLineOf(access.tenantId, input.customerId)
      : await this.repo.findLine(access.tenantId, input.customerId, input.subscriptionId);

    if (input.subscriptionId !== undefined && line === null)
      throw notFound('Subscription');

    if (input.assignedTo !== undefined) {
      // Raising a complaint and handing it to a named engineer are two things.
      requireScope(access, PERMISSIONS.TICKETS_ASSIGN);
      await this.checkAssignee(access, input.assignedTo);
    }

    const id = await this.repo.inTransaction(async (tx) => {
      const created = await this.repo.insert(tx, {
        tenantId: access.tenantId,
        ticketNo: await this.repo.nextTicketNo(tx, access.tenantId),
        customerId: input.customerId,
        subscriptionId: line?.id ?? null,
        locationId: line?.locationId ?? null,
        category: input.category ?? 'other',
        priority: input.priority ?? 'normal',
        status: 'open',
        subject: input.subject.trim(),
        description: input.description?.trim() ?? null,
        assignedTo: input.assignedTo ?? null,
        teamId: access.teamId,
        createdBy: access.userId,
      });

      await audit.created(tx, access.audit, {
        entityType: AUDIT_ENTITIES.TICKET,
        entityId: created.id,
        after: created,
      });

      return created.id;
    });

    return this.detail(access, id);
  }

  async update(access: RequestAccess, id: string, patch: UpdateTicketBody): Promise<Ticket> {
    const before = await this.reachable(access, id, PERMISSIONS.TICKETS_UPDATE);
    const resolving = patch.status !== undefined && SETTLED.includes(patch.status);

    // Closing a complaint is its own grant: an engineer may reprioritise or
    // add notes all day, but saying a fault is fixed is what the customer is
    // told, so it is checked separately.
    if (resolving)
      requireScope(access, PERMISSIONS.TICKETS_RESOLVE);

    if (patch.status === 'resolved' && (patch.resolution ?? before.resolution) === null) {
      throw badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        'Resolving a ticket needs a resolution — what was done is what the customer is told',
      );
    }

    await this.repo.inTransaction(async (tx) => {
      const after = await this.repo.update(tx, access.tenantId, id, {
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.priority === undefined ? {} : { priority: patch.priority }),
        ...(patch.category === undefined ? {} : { category: patch.category }),
        ...(patch.subject === undefined ? {} : { subject: patch.subject.trim() }),
        ...(patch.description === undefined ? {} : { description: patch.description.trim() }),
        ...(patch.resolution === undefined ? {} : { resolution: patch.resolution.trim() }),
        // Stamped once, when it settles, and never moved by a later edit.
        ...(resolving && before.resolvedAt === null
          ? { resolvedAt: new Date(), resolvedBy: access.userId }
          : {}),
      });

      await audit.updated(tx, access.audit, {
        entityType: AUDIT_ENTITIES.TICKET,
        entityId: id,
        before,
        after,
      });
    });

    return this.detail(access, id);
  }

  async assign(access: RequestAccess, id: string, input: AssignTicketBody): Promise<Ticket> {
    requireScope(access, PERMISSIONS.TICKETS_ASSIGN);
    const before = await this.reachable(access, id, PERMISSIONS.TICKETS_ASSIGN);

    if (input.assignedTo !== null)
      await this.checkAssignee(access, input.assignedTo);

    await this.repo.inTransaction(async (tx) => {
      const after = await this.repo.update(tx, access.tenantId, id, {
        assignedTo: input.assignedTo,
        // Handing a complaint to somebody is the moment it stops being a queue
        // entry and starts being work.
        ...(input.assignedTo !== null && before.status === 'open' ? { status: 'in_progress' as const } : {}),
      });

      await audit.updated(tx, access.audit, {
        entityType: AUDIT_ENTITIES.TICKET,
        entityId: id,
        before,
        after,
      });
    });

    return this.detail(access, id);
  }

  /** The stored row, once the caller is known to reach it under `key`. */
  private async reachable(access: RequestAccess, id: string, key: PermissionKey) {
    requireScope(access, key);
    const row = await this.repo.findRaw(access.tenantId, id);

    if (row === null)
      throw notFound('Ticket');

    // 404 rather than 403, as everywhere else: whether a ticket exists outside
    // your areas is not something an error should tell you.
    await this.detail(access, id);

    return row;
  }

  private async checkAssignee(access: RequestAccess, userId: string): Promise<void> {
    if (!await this.repo.isTenantMember(access.tenantId, userId)) {
      throw badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        'A ticket can only be handed to an active member of this tenant',
      );
    }
  }

  /**
   * What this caller may see, as a condition rather than a filter applied after
   * the fact — so paging counts match what comes back.
   */
  private reach(access: RequestAccess, key: PermissionKey) {
    const scope = requireScope(access, key);

    if (scope === 'ALL')
      return sql`true`;

    const mine = [
      eq(tickets.createdBy, access.userId),
      eq(tickets.assignedTo, access.userId),
    ];

    if (scope === 'OWN')
      return or(...mine)!;

    if (scope === 'ASSIGNED' || scope === 'TEAM') {
      // An engineer sees what is theirs, what their team holds, and anything
      // still unclaimed in their own areas — an unassigned fault nobody can
      // see is a fault nobody fixes.
      const team = access.teamId === null ? [] : [eq(tickets.teamId, access.teamId)];
      const inMyAreas = and(
        isNull(tickets.assignedTo),
        withinGrantedSubtree(sql`${tickets.locationId}`, access.locationIds),
      )!;

      return or(...mine, ...team, inMyAreas)!;
    }

    return or(
      ...mine,
      withinGrantedSubtree(sql`${tickets.locationId}`, access.locationIds),
    )!;
  }
}

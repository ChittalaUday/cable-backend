import type { Static, TSchema } from 'typebox';
import { Type } from 'typebox';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from '@/constants/crm';
import { StringEnum } from '@/types/typebox';
import { PaginationQuerySchema } from '@/utils/pagination';

const Uuid = Type.String({ format: 'uuid' });
const Nullable = <T extends TSchema>(inner: T) => Type.Union([inner, Type.Null()]);
const Timestamp = Type.String({ format: 'date-time' });

const Category = StringEnum(TICKET_CATEGORIES);
const Priority = StringEnum(TICKET_PRIORITIES);
const Status = StringEnum(TICKET_STATUSES);

export const TicketResponse = Type.Object({
  id: Uuid,
  /** The handle quoted on the phone, e.g. `SSCN-T-000042`. */
  ticketNo: Type.String(),
  category: Category,
  priority: Priority,
  status: Status,
  subject: Type.String(),
  description: Nullable(Type.String()),
  customer: Type.Object({
    id: Uuid,
    name: Nullable(Type.String()),
    phone: Nullable(Type.String()),
    customerCode: Nullable(Type.String()),
  }),
  /** The line it is about, when the caller named one. */
  subscription: Nullable(Type.Object({
    id: Uuid,
    serviceAccountNumber: Type.String(),
    packageName: Type.String(),
  })),
  locationId: Nullable(Uuid),
  locationPath: Nullable(Type.String()),
  assignedTo: Nullable(Type.Object({ id: Uuid, name: Nullable(Type.String()) })),
  resolution: Nullable(Type.String()),
  resolvedAt: Nullable(Timestamp),
  createdBy: Nullable(Uuid),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const ListTicketsQuery = Type.Intersect([
  PaginationQuerySchema,
  Type.Object({
    status: Type.Optional(Status),
    /** `open` folds together everything still being worked on. */
    openOnly: Type.Optional(Type.Boolean()),
    priority: Type.Optional(Priority),
    category: Type.Optional(Category),
    customerId: Type.Optional(Uuid),
    assignedTo: Type.Optional(Type.Union([Uuid, Type.Literal('me')])),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: 'Ticket number or subject' })),
  }),
]);

export const CreateTicketBody = Type.Object({
  customerId: Uuid,
  /**
   * The line the complaint is about. It also decides which area the ticket
   * lands in, so an engineer scoped to their own blocks sees it.
   */
  subscriptionId: Type.Optional(Uuid),
  category: Type.Optional(Category),
  priority: Type.Optional(Priority),
  subject: Type.String({ minLength: 3, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  /** Hand it straight to somebody. Needs `tickets.assign`. */
  assignedTo: Type.Optional(Uuid),
});

export const UpdateTicketBody = Type.Object({
  status: Type.Optional(Status),
  priority: Type.Optional(Priority),
  category: Type.Optional(Category),
  subject: Type.Optional(Type.String({ minLength: 3, maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  /** What was actually done. Required to move a ticket to `resolved`. */
  resolution: Type.Optional(Type.String({ minLength: 3, maxLength: 4000 })),
});

export const AssignTicketBody = Type.Object({
  /** Null takes it off whoever holds it and puts it back in the pool. */
  assignedTo: Nullable(Uuid),
});

export const TicketIdParams = Type.Object({ id: Uuid });

export type Ticket = Static<typeof TicketResponse>;
export type ListTicketsQuery = Static<typeof ListTicketsQuery>;
export type CreateTicketBody = Static<typeof CreateTicketBody>;
export type UpdateTicketBody = Static<typeof UpdateTicketBody>;
export type AssignTicketBody = Static<typeof AssignTicketBody>;

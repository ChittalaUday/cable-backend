import { sql } from 'drizzle-orm';
import { index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from '@/constants/crm';
import { users } from '../auth/users';
import { locations } from '../geo/locations';
import { crm } from '../schemas';
import { teams } from '../tenancy/teams';
import { tenants } from '../tenancy/tenants';
import { customers } from './customers';
import { subscriptions } from './subscriptions';

/**
 * A complaint raised about a connection — no signal, a bad picture, a bill.
 *
 * `locationId` is copied off the line when the ticket is raised rather than
 * joined for on every read: it is what every area-scoped list filters on, and a
 * line that is later relocated must not silently move old tickets out of the
 * engineer's list who worked them.
 */
export const tickets = crm.table('tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  /** The handle quoted on the phone. Filled by the database, never by a client. */
  ticketNo: text('ticket_no').notNull(),

  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  /** The line it is about, when the caller named one. */
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),

  category: text('category', { enum: TICKET_CATEGORIES }).notNull().default('other'),
  priority: text('priority', { enum: TICKET_PRIORITIES }).notNull().default('normal'),
  status: text('status', { enum: TICKET_STATUSES }).notNull().default('open'),

  subject: text('subject').notNull(),
  description: text('description'),

  assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),

  resolution: text('resolution'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),

  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('tickets_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('tickets_tenant_status_idx').on(table.tenantId, table.status),
  index('tickets_customer_idx').on(table.customerId),
  index('tickets_assigned_idx').on(table.tenantId, table.assignedTo),
  index('tickets_location_idx').on(table.tenantId, table.locationId),
  index('tickets_no_trgm_idx').using('gin', sql`${table.ticketNo} gin_trgm_ops`),
  uniqueIndex('tickets_tenant_no_uq').on(table.tenantId, table.ticketNo),
]);

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;

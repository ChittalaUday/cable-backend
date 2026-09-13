import { sql } from 'drizzle-orm';
import { boolean, integer, numeric, text, uuid } from 'drizzle-orm/pg-core';
import { analytics } from '../schemas';

export const tenantCustomerStats = analytics.view('tenant_customer_stats', {
  tenantId: uuid('tenant_id').notNull(),
  tenantCode: text('tenant_code').notNull(),
  totalCustomers: integer('total_customers').notNull(),
  activeCustomers: integer('active_customers').notNull(),
  inactiveCustomers: integer('inactive_customers').notNull(),
  pendingCustomers: integer('pending_customers').notNull(),
  addedThisMonth: integer('added_this_month').notNull(),
  outstandingTotal: numeric('outstanding_total', { precision: 14, scale: 2 }).notNull(),
}).existing();

export const messagingHealth = analytics.view('messaging_health', {
  channel: text('channel').notNull(),
  sent: integer('sent').notNull(),
  failed: integer('failed').notNull(),
  queued: integer('queued').notNull(),
  healthy: boolean('healthy').notNull(),
}).existing();

export const VIEW_DDL_OWNER = sql`-- views are created in src/db/migrations`;

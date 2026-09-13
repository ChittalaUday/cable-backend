import { sql } from 'drizzle-orm';
import { boolean, integer, numeric, text, uuid } from 'drizzle-orm/pg-core';
import { analytics } from '../schemas';

/**
 * Read models (AGENTS.md §8.3).
 *
 * §3 forbids a module joining across a domain boundary in raw SQL. A read that
 * genuinely spans domains belongs here as a named view: written once, reviewed
 * as SQL, and reused instead of re-derived in three services.
 *
 * These are declared `.existing()` — the DDL lives in a migration, because the
 * aggregates are more legible as SQL than as a query builder, and because a
 * view definition is the kind of thing you want to read in a diff.
 *
 * Views are READ ONLY. Nothing writes through one.
 */

/**
 * `analytics.tenant_customer_stats` — per-tenant customer counts and dues.
 *
 * The dashboard aggregate. Computing this by reading every customer row into the
 * application is what the old client did; one row per tenant out of Postgres is
 * the point of having a database.
 */
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

/**
 * `analytics.messaging_health` — delivery outcomes per channel over 24h.
 *
 * A failing WhatsApp session shows up here as a failure rate rather than as
 * users quietly not receiving OTPs.
 */
export const messagingHealth = analytics.view('messaging_health', {
  channel: text('channel').notNull(),
  sent: integer('sent').notNull(),
  failed: integer('failed').notNull(),
  queued: integer('queued').notNull(),
  healthy: boolean('healthy').notNull(),
}).existing();

/** Marker so `drizzle-kit` never tries to manage these; the migration owns them. */
export const VIEW_DDL_OWNER = sql`-- views are created in src/db/migrations`;

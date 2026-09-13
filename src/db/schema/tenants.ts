import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * A cable operator. Every business record in the system belongs to exactly one.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),

  /**
   * Public prefix derived from the tenant name (AGENTS.md §8.1), e.g. `SCB`.
   *
   * IMMUTABLE. Customer codes already issued embed this value and are printed on
   * receipts, so there is deliberately no update path for this column.
   */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),

  /**
   * Monotonic per-tenant counter behind `customer_code` (§8.1). Bumped with
   * `UPDATE ... RETURNING` inside the customer-insert transaction — never a
   * trigger, and never `SELECT max(...) + 1`.
   */
  customerSeq: integer('customer_seq').notNull().default(0),

  status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('tenants_status_idx').on(table.status),
]);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

import { index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

/**
 * A subscriber, scoped to one tenant (AGENTS.md §4.1).
 *
 * `userId` is nullable: an imported subscriber has a business record but no
 * login account, and may never get one.
 */
export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  /**
   * The identifier humans use — displayed, searched, read aloud (§8.1).
   * Generated in the service, never by a trigger. Never a foreign key.
   */
  customerCode: text('customer_code').notNull().unique(),

  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),

  areaId: uuid('area_id'),
  locationId: uuid('location_id'),

  status: text('status', { enum: ['active', 'inactive', 'pending'] }).notNull().default('active'),

  /** Money is `numeric` in Postgres and decimal.js in TypeScript — never a JS number (§8). */
  outstandingBalance: numeric('outstanding_balance', { precision: 12, scale: 2 }).notNull().default('0'),

  /** Scope anchor for OWN (§5). */
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  // Every query filters on tenant_id, so it leads every composite index (§8).
  index('customers_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('customers_tenant_status_idx').on(table.tenantId, table.status),
  index('customers_tenant_phone_idx').on(table.tenantId, table.phone),
  index('customers_area_idx').on(table.areaId),
  index('customers_location_idx').on(table.locationId),
  // No composite unique on (tenant_id, customer_code): the global UNIQUE on
  // customer_code already subsumes it, since tenant prefixes are unique (§8.1).
]);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

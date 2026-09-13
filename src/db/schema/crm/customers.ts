import { index, jsonb, numeric, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';

/**
 * A subscriber, scoped to one tenant (AGENTS.md §4.1).
 *
 * Identity, credentials, name, and primary phone reside on `auth.users` (§4.1).
 * Extended subscriber metadata, secondary contacts, KYC, and notes live directly here.
 * Physical addresses live in `crm.customer_addresses` for indexing and filtering.
 */
export const customers = crm.table('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  /**
   * The identifier humans use — displayed, searched, read aloud (§8.1).
   * Generated in the service, never by a trigger. Never a foreign key.
   */
  customerCode: text('customer_code').notNull().unique(),

  /** Nullable for imported subscribers that do not have a login account (§4.1). */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

  alternatePhone: varchar('alternate_phone', { length: 10 }),
  whatsappNumber: varchar('whatsapp_number', { length: 10 }),

  nationalIdType: text('national_id_type'),
  nationalIdNumber: text('national_id_number'),

  areaId: uuid('area_id'),
  locationId: uuid('location_id'),

  status: text('status', { enum: ['active', 'inactive', 'pending'] }).notNull().default('active'),

  /** Money is `numeric` in Postgres and decimal.js in TypeScript — never a JS number (§8). */
  outstandingBalance: numeric('outstanding_balance', { precision: 12, scale: 2 }).notNull().default('0'),

  notes: text('notes'),

  /** Dynamic additional properties (installation notes, provider tags, custom attributes). */
  metadata: jsonb('metadata'),

  /** Scope anchor for OWN (§5). */
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  // Every query filters on tenant_id, so it leads every composite index (§8).
  index('customers_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('customers_tenant_status_idx').on(table.tenantId, table.status),
  index('customers_user_idx').on(table.userId),
  index('customers_area_idx').on(table.areaId),
  index('customers_location_idx').on(table.locationId),
]);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

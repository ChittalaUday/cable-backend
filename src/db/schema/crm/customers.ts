import { index, jsonb, numeric, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { locations } from '../geo/locations';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const customers = crm.table('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  customerCode: text('customer_code'),

  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

  alternatePhone: varchar('alternate_phone', { length: 10 }),
  whatsappNumber: varchar('whatsapp_number', { length: 10 }),

  nationalIdType: text('national_id_type'),
  nationalIdNumber: text('national_id_number'),

  areaId: uuid('area_id').references(() => locations.id, { onDelete: 'set null' }),

  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),

  status: text('status', { enum: ['active', 'inactive', 'pending'] }).notNull().default('active'),

  outstandingBalance: numeric('outstanding_balance', { precision: 12, scale: 2 }).notNull().default('0'),

  notes: text('notes'),

  metadata: jsonb('metadata'),

  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('customers_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('customers_tenant_status_idx').on(table.tenantId, table.status),
  index('customers_user_idx').on(table.userId),
  index('customers_area_idx').on(table.areaId),
  index('customers_location_idx').on(table.locationId),
]);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

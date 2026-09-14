import { sql } from 'drizzle-orm';
import { index, jsonb, numeric, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { CUSTOMER_STATUSES } from '@/shared/constants/crm';
import { users } from '../auth/users';
import { locations } from '../geo/locations';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const customers = crm.table('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  customerCode: text('customer_code'),

  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

  name: text('name'),
  phone: varchar('phone', { length: 10 }),

  alternatePhone: varchar('alternate_phone', { length: 10 }),
  whatsappNumber: varchar('whatsapp_number', { length: 10 }),

  nationalIdType: text('national_id_type'),
  nationalIdNumber: text('national_id_number'),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  address: text('address'),
  status: text('status', { enum: CUSTOMER_STATUSES }).notNull().default('active'),
  outstandingBalance: numeric('outstanding_balance', { precision: 12, scale: 2 }).notNull().default('0'),
  notes: text('notes'),
  metadata: jsonb('metadata'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('customers_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('customers_name_trgm_idx').using('gin', sql`${table.name} gin_trgm_ops`),
  index('customers_phone_trgm_idx').using('gin', sql`${table.phone} gin_trgm_ops`),
  index('customers_code_trgm_idx').using('gin', sql`${table.customerCode} gin_trgm_ops`),
  index('customers_extra_search_trgm_idx').using('gin', sql`(
    coalesce(${table.alternatePhone}, '') || ' ' ||
    coalesce(${table.whatsappNumber}, '') || ' ' ||
    coalesce(${table.address}, '')
  ) gin_trgm_ops`).where(sql`${table.deletedAt} IS NULL`),
  index('customers_tenant_status_idx').on(table.tenantId, table.status),
  index('customers_user_idx').on(table.userId),
  index('customers_location_idx').on(table.locationId),
]);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

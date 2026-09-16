import { index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { TENANT_STATUSES } from '@/constants/tenancy';
import { tenancy } from '../schemas';

export const tenants = tenancy.table('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),

  code: text('code').notNull().unique(),
  name: text('name').notNull(),

  customerSeq: integer('customer_seq').notNull().default(0),

  status: text('status', { enum: TENANT_STATUSES }).notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('tenants_status_idx').on(table.status),
]);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

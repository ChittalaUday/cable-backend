import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { ENTITY_STATUSES } from '@/constants/crm';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const services = crm.table('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  slug: text('slug').notNull(),

  icon: text('icon'),

  description: text('description'),

  status: text('status', { enum: ENTITY_STATUSES }).notNull().default('active'),

  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('services_tenant_status_idx').on(table.tenantId, table.status),
  index('services_tenant_slug_idx').on(table.tenantId, table.slug),
]);

export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;

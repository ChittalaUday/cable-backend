import { boolean, index, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { ENTITY_STATUSES } from '@/shared/constants/crm';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { services } from './services';

export const serviceProviders = crm.table('service_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  code: text('code'),
  description: text('description'),
  contact: jsonb('contact'),
  metadata: jsonb('metadata'),
  status: text('status', { enum: ENTITY_STATUSES }).notNull().default('active'),

  /** The provider a wizard preselects when a location has more than one. */
  isDefault: boolean('is_default').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  unique('service_providers_service_slug_uq').on(table.tenantId, table.serviceId, table.slug),
  index('service_providers_tenant_service_idx').on(table.tenantId, table.serviceId),
  index('service_providers_tenant_status_idx').on(table.tenantId, table.status),
]);

export type ServiceProvider = typeof serviceProviders.$inferSelect;
export type NewServiceProvider = typeof serviceProviders.$inferInsert;

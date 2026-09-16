import { index, jsonb, numeric, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { BILLING_CYCLES, ENTITY_STATUSES, PACKAGE_TYPES } from '@/shared/constants/crm';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { serviceProviders } from './service-providers';

export const packages = crm.table('packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  serviceProviderId: uuid('service_provider_id').notNull().references(() => serviceProviders.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  slug: text('slug').notNull(),
  packageType: text('package_type', { enum: PACKAGE_TYPES }).notNull().default('base'),

  price: numeric('price', { precision: 12, scale: 2 }).notNull().default('0'),
  discount: numeric('discount', { precision: 12, scale: 2 }).notNull().default('0'),
  msoShare: numeric('mso_share', { precision: 12, scale: 2 }).notNull().default('0'),
  taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('18.00'),

  billingCycle: text('billing_cycle', { enum: BILLING_CYCLES }).notNull().default('monthly'),
  description: text('description'),

  metadata: jsonb('metadata'),

  status: text('status', { enum: ENTITY_STATUSES }).notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  unique('packages_provider_slug_uq').on(table.serviceProviderId, table.slug),
  index('packages_tenant_provider_idx').on(table.tenantId, table.serviceProviderId),
  index('packages_tenant_status_idx').on(table.tenantId, table.status),
]);

export type Package = typeof packages.$inferSelect;
export type NewPackage = typeof packages.$inferInsert;

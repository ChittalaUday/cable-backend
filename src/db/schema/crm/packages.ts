import { index, jsonb, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { BILLING_CYCLES, PACKAGE_TYPES } from '@/shared/constants/crm';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { services } from './services';

/**
 * Packages linked to services for a tenant.
 *
 * A service can have multiple packages (e.g. basic cable pack, 100 Mbps broadband).
 * Dynamic attributes (Mbps speed, data limit, OTT apps, channel counts) are stored in `metadata`.
 */
export const packages = crm.table('packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  slug: text('slug').notNull(),
  packageType: text('package_type', { enum: PACKAGE_TYPES }).notNull().default('base'),

  /** Money is `numeric(12, 2)` in Postgres (AGENTS.md §8). */
  price: numeric('price', { precision: 12, scale: 2 }).notNull().default('0'),
  discount: numeric('discount', { precision: 12, scale: 2 }).notNull().default('0'),
  msoShare: numeric('mso_share', { precision: 12, scale: 2 }).notNull().default('0'),
  taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('18.00'),

  billingCycle: text('billing_cycle', { enum: BILLING_CYCLES }).notNull().default('monthly'),
  description: text('description'),

  /** Dynamic metadata (e.g. { downloadSpeedMbps: 100, ottApps: ['Hotstar'], channelsCount: 250 }). */
  metadata: jsonb('metadata'),

  status: text('status', { enum: ['active', 'inactive'] }).notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('packages_tenant_service_idx').on(table.tenantId, table.serviceId),
  index('packages_tenant_slug_idx').on(table.tenantId, table.slug),
  index('packages_tenant_status_idx').on(table.tenantId, table.status),
]);

export type Package = typeof packages.$inferSelect;
export type NewPackage = typeof packages.$inferInsert;

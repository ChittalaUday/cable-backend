import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { SERVICE_TYPES } from '@/shared/constants/crm';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';

/**
 * Service offerings offered by a tenant (e.g. Cable TV, Broadband, IPTV).
 *
 * A single tenant can have multiple services (AGENTS.md §1, §3).
 */
export const services = crm.table('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  slug: text('slug').notNull(),
  serviceType: text('service_type', { enum: SERVICE_TYPES }).notNull(),
  providerName: text('provider_name'),
  description: text('description'),

  status: text('status', { enum: ['active', 'inactive'] }).notNull().default('active'),

  /** Dynamic configurations (e.g. MSO operator ID, gateway settings, technology details). */
  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('services_tenant_status_idx').on(table.tenantId, table.status),
  index('services_tenant_slug_idx').on(table.tenantId, table.slug),
  index('services_tenant_type_idx').on(table.tenantId, table.serviceType),
]);

export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;

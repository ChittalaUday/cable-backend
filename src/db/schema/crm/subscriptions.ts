import { sql } from 'drizzle-orm';
import { index, jsonb, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { BILLING_CYCLES, SUBSCRIPTION_STATUSES } from '@/constants/crm';
import { locations } from '../geo/locations';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { customers } from './customers';
import { packages } from './packages';
import { serviceProviders } from './service-providers';

export const subscriptions = crm.table('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),

  serviceProviderId: uuid('service_provider_id').notNull().references(() => serviceProviders.id, { onDelete: 'restrict' }),
  packageId: uuid('package_id').notNull().references(() => packages.id, { onDelete: 'restrict' }),

  serviceAccountNumber: text('service_account_number').notNull(),

  status: text('status', { enum: SUBSCRIPTION_STATUSES }).notNull().default('active'),

  startDate: timestamp('start_date', { withTimezone: true }).notNull().defaultNow(),
  endDate: timestamp('end_date', { withTimezone: true }),

  billingCycle: text('billing_cycle', { enum: BILLING_CYCLES }).notNull().default('monthly'),
  price: numeric('price', { precision: 12, scale: 2 }).notNull().default('0'),
  outstandingBalance: numeric('outstanding_balance', { precision: 12, scale: 2 }).notNull().default('0'),

  installationLocationId: uuid('installation_location_id').notNull().references(() => locations.id, { onDelete: 'restrict' }),

  installationAddress: text('installation_address'),

  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('subscriptions_tenant_customer_idx').on(table.tenantId, table.customerId),
  index('subscriptions_tenant_provider_idx').on(table.tenantId, table.serviceProviderId),
  index('subscriptions_tenant_package_idx').on(table.tenantId, table.packageId),
  index('subscriptions_tenant_status_idx').on(table.tenantId, table.status),
  index('subscriptions_tenant_account_idx').on(table.tenantId, table.serviceAccountNumber),
  index('subscriptions_search_trgm_idx').using('gin', sql`(
    ${table.serviceAccountNumber} || ' ' || coalesce(${table.installationAddress}, '')
  ) gin_trgm_ops`).where(sql`${table.deletedAt} IS NULL`),
  index('subscriptions_installation_location_idx').on(table.installationLocationId),
]);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

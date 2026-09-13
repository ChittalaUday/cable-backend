import { index, jsonb, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { BILLING_CYCLES, SUBSCRIPTION_STATUSES } from '@/shared/constants/crm';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { customerAddresses } from './customer-addresses';
import { customers } from './customers';
import { packages } from './packages';
import { services } from './services';

/**
 * Subscriber subscription / connection to a service and package.
 *
 * A customer can have multiple subscriptions across different services
 * (e.g. ACT Cable TV + Satya Fiber Broadband).
 *
 * `serviceAccountNumber` holds the upstream MSO / provider account number (e.g. `C2602498` from ACT),
 * completely decoupled from the tenant's public `customerCode` (`SSCN-000123`).
 */
export const subscriptions = crm.table('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'restrict' }),
  packageId: uuid('package_id').notNull().references(() => packages.id, { onDelete: 'restrict' }),

  /** Provider / MSO account number (e.g. `C2602498` given by ACT). */
  serviceAccountNumber: text('service_account_number').notNull(),

  status: text('status', { enum: SUBSCRIPTION_STATUSES }).notNull().default('active'),

  startDate: timestamp('start_date', { withTimezone: true }).notNull().defaultNow(),
  endDate: timestamp('end_date', { withTimezone: true }),

  billingCycle: text('billing_cycle', { enum: BILLING_CYCLES }).notNull().default('monthly'),
  price: numeric('price', { precision: 12, scale: 2 }).notNull().default('0'),

  installationAddressId: uuid('installation_address_id').references(() => customerAddresses.id, { onDelete: 'set null' }),
  installationAddress: text('installation_address'),

  /** Dynamic metadata (e.g. MSO share due, LCO customer ID, IP assignment, VLAN, ONU port). */
  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('subscriptions_tenant_customer_idx').on(table.tenantId, table.customerId),
  index('subscriptions_tenant_service_idx').on(table.tenantId, table.serviceId),
  index('subscriptions_tenant_package_idx').on(table.tenantId, table.packageId),
  index('subscriptions_tenant_status_idx').on(table.tenantId, table.status),
  index('subscriptions_tenant_account_idx').on(table.tenantId, table.serviceAccountNumber),
  index('subscriptions_address_idx').on(table.installationAddressId),
]);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

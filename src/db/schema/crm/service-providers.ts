import { boolean, index, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { services } from './services';

/**
 * The supplier actually delivering a service (docs/services-providers-packages.md).
 *
 * `Cable TV` is the service; `ACT Digital` and `Hathway` are providers of it.
 * Packages, channels and coverage all hang off the PROVIDER, because a price, a
 * channel number and a service area are things a supplier sets — not properties
 * of "cable television" in the abstract.
 *
 * A company supplying two services is two rows that share a name. That was a
 * deliberate call: one row per service costs a duplicated name, a company table
 * costs a join on every catalogue read to express something nothing queries.
 */
export const serviceProviders = crm.table('service_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  slug: text('slug').notNull(),

  /** The MSO/ISP operator id — printed on bills and quoted to the upstream. */
  code: text('code'),

  description: text('description'),

  /** `{ phone, email, portalUrl, accountManager }` — who to call when the feed is down. */
  contact: jsonb('contact'),

  metadata: jsonb('metadata'),

  status: text('status', { enum: ['active', 'inactive'] }).notNull().default('active'),

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

import { boolean, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { locations } from '../geo/locations';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { serviceProviders } from './service-providers';
import { services } from './services';

/**
 * Where a service, or one provider of it, is actually sold
 * (docs/services-providers-packages.md §3).
 *
 * **A row covers its node and everything beneath it.** One row on `Mandapeta`
 * covers every block, floor and door under it — resolved through
 * `geo.location_ancestors` (§8.6), never by expanding a subtree into rows that
 * then go stale the moment someone adds a flat.
 *
 * Precedence, and nothing else:
 *
 * 1. The nearest ancestor row **for that provider** wins.
 * 2. Failing that, the nearest row **for the service** wins.
 * 3. Failing that, it is available — a service with no rows at all sells
 *    everywhere, so a single-town operator configures nothing.
 */
export const serviceCoverage = crm.table('service_coverage', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),

  /** `null` means the row is about the whole service, whoever supplies it. */
  serviceProviderId: uuid('service_provider_id').references(() => serviceProviders.id, { onDelete: 'cascade' }),

  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),

  /**
   * `false` punches a hole: an ISP that serves the town but has not pulled
   * fibre past Block C. Without it, the only way to express a gap is to
   * enumerate every street around it, which nobody maintains.
   */
  isAvailable: boolean('is_available').notNull().default(true),

  note: text('note'),

  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // NULLS NOT DISTINCT so the service-wide row for a location collides with
  // itself; without it, "Broadband in Mandapeta" could be stated twice with
  // opposite answers.
  unique('service_coverage_uq')
    .on(table.tenantId, table.serviceId, table.serviceProviderId, table.locationId)
    .nullsNotDistinct(),
  index('service_coverage_tenant_location_idx').on(table.tenantId, table.locationId),
  index('service_coverage_tenant_provider_idx').on(table.tenantId, table.serviceProviderId),
]);

export type ServiceCoverage = typeof serviceCoverage.$inferSelect;
export type NewServiceCoverage = typeof serviceCoverage.$inferInsert;

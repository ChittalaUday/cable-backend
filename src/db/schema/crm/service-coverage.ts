import { boolean, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { locations } from '../geo/locations';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { packages } from './packages';
import { serviceProviders } from './service-providers';
import { services } from './services';

export const serviceCoverage = crm.table('service_coverage', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  serviceProviderId: uuid('service_provider_id').references(() => serviceProviders.id, { onDelete: 'cascade' }),
  packageId: uuid('package_id').references(() => packages.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  isAvailable: boolean('is_available').notNull().default(true),
  note: text('note'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('service_coverage_uq')
    .on(table.tenantId, table.serviceId, table.serviceProviderId, table.packageId, table.locationId)
    .nullsNotDistinct(),
  index('service_coverage_tenant_location_idx').on(table.tenantId, table.locationId),
  index('service_coverage_tenant_provider_idx').on(table.tenantId, table.serviceProviderId),
  index('service_coverage_tenant_package_idx').on(table.tenantId, table.packageId),
  index('service_coverage_tenant_avail_idx').on(table.tenantId, table.isAvailable),
]);

export type ServiceCoverage = typeof serviceCoverage.$inferSelect;
export type NewServiceCoverage = typeof serviceCoverage.$inferInsert;

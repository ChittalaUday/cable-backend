import { index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { LOCATION_ALIAS_SOURCES } from '@/constants/geo';
import { geo } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { locations } from './locations';

export const locationAliases = geo.table('location_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),

  alias: text('alias').notNull(),
  source: text('source', { enum: LOCATION_ALIAS_SOURCES }).notNull().default('admin'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('location_aliases_uq').on(table.locationId, table.alias),
  index('location_aliases_tenant_idx').on(table.tenantId),
]);

export type LocationAlias = typeof locationAliases.$inferSelect;
export type NewLocationAlias = typeof locationAliases.$inferInsert;

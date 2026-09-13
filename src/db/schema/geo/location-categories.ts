import { jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { geo } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const locationCategories = geo.table('location_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  slug: text('slug').notNull(),

  config: jsonb('config').notNull().default({}),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('location_categories_tenant_slug_uq').on(table.tenantId, table.slug),
]);

export type LocationCategory = typeof locationCategories.$inferSelect;
export type NewLocationCategory = typeof locationCategories.$inferInsert;

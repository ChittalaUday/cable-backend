import { boolean, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { geo } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const locationSchemas = geo.table('location_schemas', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('location_schemas_tenant_slug_uq').on(table.tenantId, table.slug),
]);

export type LocationSchema = typeof locationSchemas.$inferSelect;
export type NewLocationSchema = typeof locationSchemas.$inferInsert;

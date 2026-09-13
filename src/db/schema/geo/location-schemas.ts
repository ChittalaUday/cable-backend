import { boolean, integer, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { geo } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { locationCategories } from './location-categories';

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

export const locationSchemaLevels = geo.table('location_schema_levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  schemaId: uuid('schema_id').notNull().references(() => locationSchemas.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => locationCategories.id, { onDelete: 'no action' }),

  depth: integer('depth').notNull(),

  isTerminal: boolean('is_terminal').notNull().default(false),

  config: jsonb('config').notNull().default({}),
}, table => [
  unique('location_schema_levels_depth_uq').on(table.schemaId, table.depth),
  unique('location_schema_levels_category_uq').on(table.schemaId, table.categoryId),
]);

export type LocationSchema = typeof locationSchemas.$inferSelect;
export type NewLocationSchema = typeof locationSchemas.$inferInsert;
export type LocationSchemaLevel = typeof locationSchemaLevels.$inferSelect;
export type NewLocationSchemaLevel = typeof locationSchemaLevels.$inferInsert;

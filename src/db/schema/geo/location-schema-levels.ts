import { boolean, integer, jsonb, unique, uuid } from 'drizzle-orm/pg-core';
import { geo } from '../schemas';
import { locationCategories } from './location-categories';
import { locationSchemas } from './location-schemas';

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

export type LocationSchemaLevel = typeof locationSchemaLevels.$inferSelect;
export type NewLocationSchemaLevel = typeof locationSchemaLevels.$inferInsert;

import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, numeric, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { LOCATION_SOURCES, LOCATION_STATUSES } from '@/constants/geo';
import { users } from '../auth/users';
import { geo } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { locationCategories } from './location-categories';
import { locationSchemas } from './location-schemas';

export const locations = geo.table('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  schemaId: uuid('schema_id').notNull().references(() => locationSchemas.id, { onDelete: 'no action' }),
  categoryId: uuid('category_id').notNull().references(() => locationCategories.id, { onDelete: 'no action' }),

  parentId: uuid('parent_id').references((): AnyPgColumn => locations.id, { onDelete: 'no action' }),

  name: text('name').notNull(),
  code: text('code'),

  source: text('source', { enum: LOCATION_SOURCES }).notNull().default('admin'),

  status: text('status', { enum: LOCATION_STATUSES }).notNull().default('approved'),

  isActive: boolean('is_active').notNull().default(true),

  latitude: numeric('latitude', { precision: 10, scale: 7 }),
  longitude: numeric('longitude', { precision: 10, scale: 7 }),

  metadata: jsonb('metadata'),

  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  // Partial, so a name freed by a soft delete can be used again — a plain
  // constraint would keep the dead row's name reserved forever. `parent_id` is
  // coalesced to the nil uuid because a partial unique index cannot also be
  // NULLS NOT DISTINCT, and two roots of the same name must still collide.
  uniqueIndex('locations_parent_name_uq')
    .on(table.tenantId, sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`, table.name)
    .where(sql`deleted_at IS NULL`),
  check('locations_not_own_parent', sql`parent_id IS NULL OR parent_id <> id`),
  index('locations_tenant_parent_idx').on(table.tenantId, table.parentId),
  index('locations_tenant_category_idx').on(table.tenantId, table.categoryId),
  index('locations_tenant_schema_idx').on(table.tenantId, table.schemaId),
  index('locations_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('locations_code_trgm_idx').using('gin', sql`${table.code} gin_trgm_ops`),
  index('locations_tenant_live_idx').on(table.tenantId).where(sql`deleted_at IS NULL`),
]);

export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;

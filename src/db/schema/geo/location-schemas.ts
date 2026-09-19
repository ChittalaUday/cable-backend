import { sql } from 'drizzle-orm';
import { boolean, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  uniqueIndex('location_schemas_tenant_slug_uq')
    .on(table.tenantId, table.slug)
    .where(sql`deleted_at IS NULL`),
]);

export type LocationSchema = typeof locationSchemas.$inferSelect;
export type NewLocationSchema = typeof locationSchemas.$inferInsert;

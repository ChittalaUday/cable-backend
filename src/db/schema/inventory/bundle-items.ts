import { boolean, index, integer, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { inventory } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { itemCatalog } from './item-catalog';

export const bundleItems = inventory.table('bundle_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  bundleCatalogId: uuid('bundle_catalog_id').notNull().references(() => itemCatalog.id, { onDelete: 'cascade' }),
  componentCatalogId: uuid('component_catalog_id').notNull().references(() => itemCatalog.id, { onDelete: 'cascade' }),

  quantity: integer('quantity').notNull().default(1),
  isOptional: boolean('is_optional').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('bundle_items_unique_component').on(table.tenantId, table.bundleCatalogId, table.componentCatalogId),
  index('bundle_items_tenant_bundle_idx').on(table.tenantId, table.bundleCatalogId),
]);

export type BundleItemRecord = typeof bundleItems.$inferSelect;
export type NewBundleItemRecord = typeof bundleItems.$inferInsert;

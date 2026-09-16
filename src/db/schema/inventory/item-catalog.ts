import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, numeric, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import {
  EQUIPMENT_OWNERSHIPS,
  TRACKING_TYPES,
} from '@/shared/constants/inventory';
import { inventory } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { itemTypes } from './item-types';

export const itemCatalog = inventory.table('item_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  itemTypeId: uuid('item_type_id').references(() => itemTypes.id, { onDelete: 'set null' }),

  name: text('name').notNull(),
  code: text('code'),
  brand: text('brand'),
  model: text('model'),
  icon: text('icon'),
  description: text('description'),

  trackingType: text('tracking_type', { enum: TRACKING_TYPES }).notNull().default('serialized'),
  isBundle: boolean('is_bundle').notNull().default(false),

  defaultOwnership: text('default_ownership', { enum: EQUIPMENT_OWNERSHIPS }).notNull().default('tenant_provided'),
  defaultSalePrice: numeric('default_sale_price', { precision: 12, scale: 2 }).notNull().default('0'),
  defaultDepositAmount: numeric('default_deposit_amount', { precision: 12, scale: 2 }).notNull().default('0'),
  defaultRentalPrice: numeric('default_rental_price', { precision: 12, scale: 2 }).notNull().default('0'),

  isReturnable: boolean('is_returnable').notNull().default(true),

  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('item_catalog_tenant_code_uq').on(table.tenantId, table.code).nullsNotDistinct(),
  index('item_catalog_tenant_idx').on(table.tenantId),
  index('item_catalog_tenant_type_idx').on(table.tenantId, table.itemTypeId),
  index('item_catalog_search_trgm_idx').using('gin', sql`(
    coalesce(${table.name}, '') || ' ' || coalesce(${table.code}, '') || ' ' ||
    coalesce(${table.brand}, '') || ' ' || coalesce(${table.model}, '')
  ) gin_trgm_ops`),
]);

export type ItemCatalogRecord = typeof itemCatalog.$inferSelect;
export type NewItemCatalogRecord = typeof itemCatalog.$inferInsert;

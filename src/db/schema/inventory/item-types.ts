import { boolean, index, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { inventory } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const itemTypes = inventory.table('item_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  code: text('code').notNull(),
  icon: text('icon'),
  description: text('description'),

  isSerialized: boolean('is_serialized').notNull().default(false),
  isReturnable: boolean('is_returnable').notNull().default(true),

  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('item_types_tenant_code_uq').on(table.tenantId, table.code),
  index('item_types_tenant_idx').on(table.tenantId),
]);

export type ItemTypeRecord = typeof itemTypes.$inferSelect;
export type NewItemTypeRecord = typeof itemTypes.$inferInsert;

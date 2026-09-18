import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  EQUIPMENT_OWNERSHIPS,
  INVENTORY_STATUSES,
} from '@/constants/inventory';
import { users } from '../auth/users';
import { locations } from '../geo/locations';
import { inventory } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { itemCatalog } from './item-catalog';

export const equipment = inventory.table('equipment', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  catalogId: uuid('catalog_id').references(() => itemCatalog.id, { onDelete: 'restrict' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'restrict' }),
  staffId: uuid('staff_id').references(() => users.id, { onDelete: 'restrict' }),
  serialNumber: text('serial_number'),
  vcNumber: text('vc_number'),
  macAddress: text('mac_address'),
  barcode: text('barcode'),
  ownershipType: text('ownership_type', { enum: EQUIPMENT_OWNERSHIPS }).notNull().default('tenant_provided'),
  depositAmount: numeric('deposit_amount', { precision: 12, scale: 2 }).notNull().default('0'),
  costPrice: numeric('cost_price', { precision: 12, scale: 2 }).notNull().default('0'),
  isReturnable: boolean('is_returnable').notNull().default(true),
  inventoryStatus: text('inventory_status', { enum: INVENTORY_STATUSES }).notNull().default('available'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('equipment_tenant_serial_idx').on(table.tenantId, table.serialNumber),
  index('equipment_tenant_vc_idx').on(table.tenantId, table.vcNumber),
  index('equipment_tenant_mac_idx').on(table.tenantId, table.macAddress),
  index('equipment_tenant_inv_status_idx').on(table.tenantId, table.inventoryStatus),
  index('equipment_tenant_location_idx').on(table.tenantId, table.locationId),
  index('equipment_tenant_staff_idx').on(table.tenantId, table.staffId),
  index('equipment_tenant_catalog_idx').on(table.tenantId, table.catalogId),
  index('equipment_search_trgm_idx').using('gin', sql`(
    coalesce(${table.serialNumber}, '') || ' ' || coalesce(${table.vcNumber}, '') || ' ' ||
    coalesce(${table.macAddress}, '') || ' ' || coalesce(${table.barcode}, '')
  ) gin_trgm_ops`),
]);

export type Equipment = typeof equipment.$inferSelect;
export type NewEquipment = typeof equipment.$inferInsert;

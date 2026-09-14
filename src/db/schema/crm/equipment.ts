import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  EQUIPMENT_INVENTORY_STATUSES,
  EQUIPMENT_OWNERSHIPS,
  EQUIPMENT_TYPES,
} from '@/shared/constants/crm';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const equipment = crm.table('equipment', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  equipmentType: text('equipment_type', { enum: EQUIPMENT_TYPES }).notNull().default('stb'),

  brand: text('brand'),
  model: text('model'),

  serialNumber: text('serial_number'),
  vcNumber: text('vc_number'),
  macAddress: text('mac_address'),
  barcode: text('barcode'),

  ownershipType: text('ownership_type', { enum: EQUIPMENT_OWNERSHIPS }).notNull().default('tenant_provided'),
  depositAmount: numeric('deposit_amount', { precision: 12, scale: 2 }).notNull().default('0'),

  isReturnable: boolean('is_returnable').notNull().default(true),

  inventoryStatus: text('inventory_status', { enum: EQUIPMENT_INVENTORY_STATUSES }).notNull().default('available'),

  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('equipment_tenant_serial_idx').on(table.tenantId, table.serialNumber),
  index('equipment_tenant_vc_idx').on(table.tenantId, table.vcNumber),
  index('equipment_tenant_mac_idx').on(table.tenantId, table.macAddress),
  index('equipment_tenant_inv_status_idx').on(table.tenantId, table.inventoryStatus),
  index('equipment_tenant_type_idx').on(table.tenantId, table.equipmentType),
  index('equipment_search_trgm_idx').using('gin', sql`(
    coalesce(${table.serialNumber}, '') || ' ' || coalesce(${table.vcNumber}, '') || ' ' ||
    coalesce(${table.macAddress}, '') || ' ' || coalesce(${table.barcode}, '') || ' ' ||
    coalesce(${table.brand}, '') || ' ' || coalesce(${table.model}, '') || ' ' || ${table.equipmentType}
  ) gin_trgm_ops`),
]);

export type Equipment = typeof equipment.$inferSelect;
export type NewEquipment = typeof equipment.$inferInsert;

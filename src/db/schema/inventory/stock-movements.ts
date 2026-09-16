import { index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { STOCK_MOVEMENT_TYPES } from '@/constants/inventory';
import { users } from '../auth/users';
import { locations } from '../geo/locations';
import { inventory } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { equipment } from './equipment';

export const stockMovements = inventory.table('stock_movements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  equipmentId: uuid('equipment_id').notNull().references(() => equipment.id, { onDelete: 'cascade' }),

  movementType: text('movement_type', { enum: STOCK_MOVEMENT_TYPES }).notNull(),

  fromLocationId: uuid('from_location_id').references(() => locations.id, { onDelete: 'set null' }),
  toLocationId: uuid('to_location_id').references(() => locations.id, { onDelete: 'set null' }),

  fromStaffId: uuid('from_staff_id').references(() => users.id, { onDelete: 'set null' }),
  toStaffId: uuid('to_staff_id').references(() => users.id, { onDelete: 'set null' }),

  performedBy: uuid('performed_by').references(() => users.id, { onDelete: 'set null' }),

  quantity: integer('quantity').notNull().default(1),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('stock_movements_tenant_eq_idx').on(table.tenantId, table.equipmentId),
  index('stock_movements_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('stock_movements_tenant_type_idx').on(table.tenantId, table.movementType),
]);

export type StockMovementRecord = typeof stockMovements.$inferSelect;
export type NewStockMovementRecord = typeof stockMovements.$inferInsert;

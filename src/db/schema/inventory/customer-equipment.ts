import { sql } from 'drizzle-orm';
import { index, numeric, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  CUSTOMER_EQUIPMENT_STATUSES,
  DEPOSIT_REFUND_STATUSES,
  EQUIPMENT_OWNERSHIPS,
  EQUIPMENT_RETURN_CONDITIONS,
} from '@/constants/inventory';
import { users } from '../auth/users';
import { customers } from '../crm/customers';
import { subscriptions } from '../crm/subscriptions';
import { locations } from '../geo/locations';
import { inventory } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { equipment } from './equipment';

export const customerEquipment = inventory.table('customer_equipment', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  equipmentId: uuid('equipment_id').notNull().references(() => equipment.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'restrict' }),

  status: text('status', { enum: CUSTOMER_EQUIPMENT_STATUSES }).notNull().default('active'),
  ownershipType: text('ownership_type', { enum: EQUIPMENT_OWNERSHIPS }).notNull().default('tenant_provided'),

  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'restrict' }),

  returnedAt: timestamp('returned_at', { withTimezone: true }),
  returnCondition: text('return_condition', { enum: EQUIPMENT_RETURN_CONDITIONS }),
  collectedBy: uuid('collected_by').references(() => users.id, { onDelete: 'restrict' }),
  returnedToLocationId: uuid('returned_to_location_id').references(() => locations.id, { onDelete: 'restrict' }),
  returnRemarks: text('return_remarks'),

  replacedByEquipmentId: uuid('replaced_by_equipment_id').references(() => equipment.id, { onDelete: 'restrict' }),

  depositRefundStatus: text('deposit_refund_status', { enum: DEPOSIT_REFUND_STATUSES }).notNull().default('not_applicable'),
  depositDeductionAmount: numeric('deposit_deduction_amount', { precision: 12, scale: 2 }).notNull().default('0'),

  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('customer_equipment_active_equipment_unique_idx')
    .on(table.tenantId, table.equipmentId)
    .where(sql`${table.status} IN ('active', 'standby')`),
  index('customer_equipment_tenant_sub_idx').on(table.tenantId, table.subscriptionId),
  index('customer_equipment_tenant_cust_idx').on(table.tenantId, table.customerId),
  index('customer_equipment_tenant_cust_status_idx').on(table.tenantId, table.customerId, table.status),
  index('customer_equipment_tenant_eq_idx').on(table.tenantId, table.equipmentId),
  index('customer_equipment_tenant_eq_assigned_idx').on(table.tenantId, table.equipmentId, table.assignedAt.desc()),
  index('customer_equipment_tenant_status_idx').on(table.tenantId, table.status),
]);

export type CustomerEquipment = typeof customerEquipment.$inferSelect;
export type NewCustomerEquipment = typeof customerEquipment.$inferInsert;

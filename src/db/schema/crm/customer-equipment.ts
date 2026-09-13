import { index, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  EQUIPMENT_RETURN_CONDITIONS,
  EQUIPMENT_STATUSES,
} from '@/shared/constants/crm';
import { users } from '../auth/users';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { customers } from './customers';
import { equipment } from './equipment';
import { subscriptions } from './subscriptions';

/**
 * Mapping between Customer / Subscription and Hardware Equipment Asset.
 *
 * Tracks the complete allocation and return lifecycle:
 * when assigned, which technician installed it, when returned upon cancellation,
 * physical condition upon return, deposit refunds, and collection technician.
 */
export const customerEquipment = crm.table('customer_equipment', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  equipmentId: uuid('equipment_id').notNull().references(() => equipment.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  subscriptionId: uuid('subscription_id').notNull().references(() => subscriptions.id, { onDelete: 'cascade' }),

  status: text('status', { enum: EQUIPMENT_STATUSES }).notNull().default('active'),

  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),

  /** Recorded when customer cancels and equipment is collected. */
  returnedAt: timestamp('returned_at', { withTimezone: true }),
  returnCondition: text('return_condition', { enum: EQUIPMENT_RETURN_CONDITIONS }),
  collectedBy: uuid('collected_by').references(() => users.id, { onDelete: 'set null' }),
  refundedAmount: numeric('refunded_amount', { precision: 12, scale: 2 }).notNull().default('0'),
  returnRemarks: text('return_remarks'),

  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('customer_equipment_tenant_sub_idx').on(table.tenantId, table.subscriptionId),
  index('customer_equipment_tenant_cust_idx').on(table.tenantId, table.customerId),
  index('customer_equipment_tenant_eq_idx').on(table.tenantId, table.equipmentId),
  index('customer_equipment_tenant_status_idx').on(table.tenantId, table.status),
]);

export type CustomerEquipment = typeof customerEquipment.$inferSelect;
export type NewCustomerEquipment = typeof customerEquipment.$inferInsert;

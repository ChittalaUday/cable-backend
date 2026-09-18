import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, numeric, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { COLLECTION_OUTCOMES, PAYMENT_METHODS } from '@/constants/billing';
import { users } from '../auth/users';
import { accountTransactions } from '../crm/account-transactions';
import { customers } from '../crm/customers';
import { subscriptions } from '../crm/subscriptions';
import { customerEquipment } from '../inventory/customer-equipment';
import { billing } from '../schemas';
import { tenants } from '../tenancy/tenants';

function values(allowed: readonly string[]): SQL {
  return sql`(${sql.join(allowed.map(value => sql.raw(`'${value}'`)), sql`, `)})`;
}

export const collections = billing.table('collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'restrict' }),
  customerEquipmentId: uuid('customer_equipment_id').references(() => customerEquipment.id, { onDelete: 'restrict' }),
  collectedBy: uuid('collected_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  outcome: text('outcome', { enum: COLLECTION_OUTCOMES }).notNull(),
  method: text('method', { enum: PAYMENT_METHODS }),
  dueAmount: numeric('due_amount', { precision: 12, scale: 2 }).notNull().default('0'),
  duesPaid: numeric('dues_paid', { precision: 12, scale: 2 }).notNull().default('0'),
  totalCollected: numeric('total_collected', { precision: 12, scale: 2 })
    .notNull()
    .generatedAlwaysAs(sql`dues_paid`),
  balanceAfter: numeric('balance_after', { precision: 12, scale: 2 }).notNull().default('0'),
  transactionId: uuid('transaction_id').references(() => accountTransactions.id, { onDelete: 'restrict' }),
  reversesId: uuid('reverses_id'),
  latitude: numeric('latitude', { precision: 10, scale: 7 }),
  longitude: numeric('longitude', { precision: 10, scale: 7 }),
  gpsAccuracyM: numeric('gps_accuracy_m', { precision: 8, scale: 2 }),
  reason: text('reason'),
  notes: text('notes'),
  reference: text('reference').notNull(),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('collections_tenant_reference_uq').on(table.tenantId, table.reference),
  unique('collections_reverses_uq').on(table.reversesId),
  index('collections_tenant_collected_idx').on(table.tenantId, table.collectedAt.desc()),
  index('collections_tenant_collector_idx').on(table.tenantId, table.collectedBy, table.collectedAt.desc()),
  index('collections_tenant_customer_idx').on(table.tenantId, table.customerId, table.collectedAt.desc()),
  index('collections_tenant_customer_equipment_idx').on(table.tenantId, table.customerEquipmentId),
  foreignKey({
    columns: [table.reversesId],
    foreignColumns: [table.id],
    name: 'collections_reverses_id_collections_id_fk',
  }).onDelete('restrict'),
  check('collections_outcome_check', sql`${table.outcome} IN ${values(COLLECTION_OUTCOMES)}`),
  check('collections_method_check', sql`${table.method} IS NULL OR ${table.method} IN ${values(PAYMENT_METHODS)}`),
  check('collections_target_check', sql`${table.subscriptionId} IS NOT NULL OR ${table.customerEquipmentId} IS NOT NULL`),
  check('collections_no_payment_is_empty', sql`${table.outcome} <> 'none' OR ${table.duesPaid} = 0`),
  check('collections_takings_not_negative', sql`${table.outcome} = 'refund' OR ${table.duesPaid} >= 0`),
  check('collections_refund_gives_back', sql`${table.outcome} <> 'refund' OR ${table.duesPaid} <= 0`),
  check('collections_point_is_whole', sql`(${table.latitude} IS NULL) = (${table.longitude} IS NULL)`),
  check('collections_point_is_on_earth', sql`${table.latitude} IS NULL OR (${table.latitude} BETWEEN -90 AND 90 AND ${table.longitude} BETWEEN -180 AND 180)`),
  index('collections_point_gix')
    .using('gist', sql`(${pointOf(table.longitude, table.latitude)})`)
    .where(sql`${table.latitude} IS NOT NULL`),
]);

export function pointOf(longitude: unknown, latitude: unknown): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${longitude}::double precision, ${latitude}::double precision), 4326)::geography`;
}

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;

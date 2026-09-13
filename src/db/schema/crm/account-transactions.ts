import { index, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { TRANSACTION_TYPES } from '@/shared/constants/crm';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { customers } from './customers';
import { services } from './services';
import { subscriptions } from './subscriptions';

export const accountTransactions = crm.table('account_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),

  serviceAccountNumber: text('service_account_number').notNull(),
  transactionNo: text('transaction_no').notNull(),
  transactionDate: timestamp('transaction_date', { withTimezone: true }).notNull(),

  transactionType: text('transaction_type', { enum: TRANSACTION_TYPES }).notNull(),
  remarks: text('remarks'),

  debit: numeric('debit', { precision: 12, scale: 2 }).notNull().default('0'),
  credit: numeric('credit', { precision: 12, scale: 2 }).notNull().default('0'),
  closingBalance: numeric('closing_balance', { precision: 12, scale: 2 }).notNull().default('0'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('account_tx_tenant_service_idx').on(table.tenantId, table.serviceId),
  index('account_tx_tenant_acc_idx').on(table.tenantId, table.serviceAccountNumber),
  index('account_tx_tenant_cust_idx').on(table.tenantId, table.customerId),
  index('account_tx_tenant_tx_idx').on(table.tenantId, table.transactionNo),
  index('account_tx_tenant_date_idx').on(table.tenantId, table.transactionDate.desc()),
]);

export type AccountTransaction = typeof accountTransactions.$inferSelect;
export type NewAccountTransaction = typeof accountTransactions.$inferInsert;

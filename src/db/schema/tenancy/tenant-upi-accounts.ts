import { sql } from 'drizzle-orm';
import { boolean, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ENTITY_STATUSES } from '@/constants/crm';
import { tenancy } from '../schemas';
import { tenants } from './tenants';

/**
 * The UPI handles an operator collects into.
 *
 * A table rather than a column on the tenant, because an operator runs more
 * than one: a personal handle for the round, a firm's current account for the
 * office, sometimes one per area so the settlement is obvious at the bank end.
 * The collector picks which to show, and one is marked `isDefault` so the
 * common case is no decision at all.
 */
export const tenantUpiAccounts = tenancy.table('tenant_upi_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  /** The VPA money is sent to, e.g. `satyacable@okhdfc`. */
  upiId: text('upi_id').notNull(),
  /** The name the payer's app shows before they confirm. */
  payeeName: text('payee_name').notNull(),
  /** What staff call it in the picker: "Shop counter", "Mandapeta round". */
  label: text('label'),

  isDefault: boolean('is_default').notNull().default(false),
  status: text('status', { enum: ENTITY_STATUSES }).notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('tenant_upi_accounts_tenant_idx').on(table.tenantId),
  // The same handle twice in one tenant is a typo, not a second account.
  uniqueIndex('tenant_upi_accounts_tenant_vpa_uq')
    .on(table.tenantId, table.upiId)
    .where(sql`${table.deletedAt} IS NULL`),
]);

export type TenantUpiAccount = typeof tenantUpiAccounts.$inferSelect;
export type NewTenantUpiAccount = typeof tenantUpiAccounts.$inferInsert;

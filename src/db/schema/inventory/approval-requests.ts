import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { INVENTORY_REQUEST_STATUSES, INVENTORY_REQUEST_TYPES } from '@/constants/inventory';
import { users } from '../auth/users';
import { inventory } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { itemCatalog } from './item-catalog';

export const approvalRequests = inventory.table('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  requestedBy: uuid('requested_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  requestType: text('request_type', { enum: INVENTORY_REQUEST_TYPES }).notNull(),
  targetItemId: uuid('target_item_id').references(() => itemCatalog.id, { onDelete: 'restrict' }),

  proposedData: jsonb('proposed_data').$type<Record<string, unknown>>(),
  reason: text('reason').notNull(),

  status: text('status', { enum: INVENTORY_REQUEST_STATUSES }).notNull().default('pending'),

  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'restrict' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNotes: text('review_notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('approval_requests_tenant_status_idx').on(table.tenantId, table.status),
  index('approval_requests_tenant_req_by_idx').on(table.tenantId, table.requestedBy),
  index('approval_requests_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
]);

export type ApprovalRequestRecord = typeof approvalRequests.$inferSelect;
export type NewApprovalRequestRecord = typeof approvalRequests.$inferInsert;

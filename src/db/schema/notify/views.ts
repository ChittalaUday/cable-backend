import { integer, timestamp, uuid } from 'drizzle-orm/pg-core';
import { notify } from '../schemas';

/**
 * `notify.user_unread_counts` — unread in-app notifications per (tenant, user).
 *
 * Named so the badge count is one definition rather than a filter every caller
 * re-types and eventually gets subtly wrong.
 */
export const userUnreadCounts = notify.view('user_unread_counts', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  unreadCount: integer('unread_count').notNull(),
  latestAt: timestamp('latest_at', { withTimezone: true }),
}).existing();

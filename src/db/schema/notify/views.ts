import { integer, timestamp, uuid } from 'drizzle-orm/pg-core';
import { notify } from '../schemas';

export const userUnreadCounts = notify.view('user_unread_counts', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  unreadCount: integer('unread_count').notNull(),
  latestAt: timestamp('latest_at', { withTimezone: true }),
}).existing();

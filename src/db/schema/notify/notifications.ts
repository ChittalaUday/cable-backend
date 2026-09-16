import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES } from '@/shared/constants/notify';
import { users } from '../auth/users';
import { files } from '../media/files';
import { notify } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const notifications = notify.table('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),

  channel: text('channel', { enum: NOTIFICATION_CHANNELS }).notNull(),
  type: text('type').notNull(),

  title: text('title'),
  body: text('body').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>(),

  destination: text('destination'),

  fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),

  status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('queued'),
  provider: text('provider'),
  providerMessageId: text('provider_message_id'),
  error: text('error'),

  sentAt: timestamp('sent_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('notifications_user_created_idx').on(table.userId, table.createdAt.desc()),
  index('notifications_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('notifications_status_idx').on(table.status),
]);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

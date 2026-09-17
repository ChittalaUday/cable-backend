import { sql } from 'drizzle-orm';
import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS, NOTIFICATION_DELIVERIES, NOTIFICATION_STATUSES } from '@/constants/notify';
import { users } from '../auth/users';
import { files } from '../media/files';
import { notify } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const notifications = notify.table('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),

  channel: text('channel', { enum: NOTIFICATION_CHANNELS }).notNull(),

  category: text('category', { enum: NOTIFICATION_CATEGORIES }).notNull().default('general'),
  delivery: text('delivery', { enum: NOTIFICATION_DELIVERIES }).notNull().default('notification'),

  type: text('type').notNull(),

  title: text('title'),
  body: text('body').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>(),

  imageUrl: text('image_url'),

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
  index('notifications_pending_in_app_idx')
    .on(table.userId, table.createdAt.desc())
    .where(sql`${table.delivery} = 'in_app' AND ${table.readAt} IS NULL`),
]);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

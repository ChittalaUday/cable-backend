import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { notify } from './schemas';
import { tenants } from './tenants';
import { users } from './users';

/** What a caller asks for. `in_app` is delivered by being readable; the rest go over a transport. */
export const NOTIFICATION_CHANNELS = ['in_app', 'whatsapp', 'sms'] as const;
export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed'] as const;

/**
 * One notification on one channel (AGENTS.md §8.2).
 *
 * A notification sent to two channels is two rows. That keeps delivery state
 * per-channel without a `whatsapp_status` / `sms_status` column pair, and it
 * makes "what did we actually send this customer" one query.
 *
 * `tenantId` and `userId` are nullable on purpose: an OTP to a phone number
 * that has no account yet belongs to neither.
 */
export const notifications = notify.table('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),

  channel: text('channel', { enum: NOTIFICATION_CHANNELS }).notNull(),
  /** Machine key the client switches on, e.g. `otp`, `payment_due`, `ticket_assigned`. */
  type: text('type').notNull(),

  /** In-app needs a title; a WhatsApp or SMS body carries its own opening line. */
  title: text('title'),
  /**
   * Redacted for sensitive sends. An OTP row records that a code went out, never
   * the code itself — a notification table is not a place to keep credentials.
   */
  body: text('body').notNull(),
  /** Payload the client uses to deep-link. Never secrets. */
  data: jsonb('data').$type<Record<string, unknown>>(),

  /** Phone number for a transport channel; null for `in_app`. */
  destination: text('destination'),

  status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('queued'),
  provider: text('provider'),
  providerMessageId: text('provider_message_id'),
  error: text('error'),

  sentAt: timestamp('sent_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  /** Only meaningful for `in_app`. Distinct from `status`: delivered ≠ read. */
  readAt: timestamp('read_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // The inbox query: one user's notifications, newest first.
  index('notifications_user_created_idx').on(table.userId, table.createdAt.desc()),
  index('notifications_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('notifications_status_idx').on(table.status),
]);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

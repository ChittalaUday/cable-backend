import { index, jsonb, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { notify } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const MESSAGE_CHANNELS = ['sms', 'whatsapp', 'email', 'push'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const messages = notify.table('messages', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),

  channel: text('channel', { enum: MESSAGE_CHANNELS }).notNull(),
  provider: text('provider').notNull(),
  destination: text('destination').notNull(),
  sender: text('sender'),

  subject: text('subject'),
  content: text('content').notNull(),
  templateId: text('template_id'),
  templateParams: jsonb('template_params').$type<Record<string, unknown>>(),

  status: text('status', { enum: MESSAGE_STATUSES }).notNull().default('queued'),
  providerMessageId: text('provider_message_id'),
  providerResponse: jsonb('provider_response').$type<Record<string, unknown>>(),
  cost: numeric('cost', { precision: 10, scale: 4 }),
  error: text('error'),
  errorCode: text('error_code'),

  sentAt: timestamp('sent_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('messages_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('messages_provider_msg_id_idx').on(table.provider, table.providerMessageId),
  index('messages_status_idx').on(table.status),
  index('messages_destination_idx').on(table.destination),
  index('messages_channel_idx').on(table.channel),
]);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

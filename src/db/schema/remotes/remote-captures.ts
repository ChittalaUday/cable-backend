import { boolean, index, integer, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { remotesSchema } from '../schemas';
import { remotes } from './remotes';

export const remoteCaptures = remotesSchema.table('remote_captures', {
  id: uuid('id').primaryKey().defaultRandom(),

  remoteId: uuid('remote_id').references(() => remotes.id, { onDelete: 'cascade' }),

  buttonName: text('button_name').notNull(),
  buttonKey: text('button_key').notNull(),

  protocol: text('protocol').notNull(),
  address: text('address').notNull(),
  command: text('command').notNull(),
  commandNumber: integer('command_number').notNull(),
  rawData: text('raw_data').notNull(),
  bits: integer('bits').notNull(),
  bitOrder: text('bit_order').notNull(),
  repeat: boolean('repeat').notNull().default(false),

  rawTimings: jsonb('raw_timings').$type<number[]>().notNull(),

  capturedAt: timestamp('captured_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('remote_captures_remote_btn_uq').on(table.remoteId, table.buttonName),
  index('remote_captures_remote_idx').on(table.remoteId),
  index('remote_captures_btn_key_idx').on(table.buttonKey),
]);

export type RemoteCaptureRecord = typeof remoteCaptures.$inferSelect;
export type NewRemoteCaptureRecord = typeof remoteCaptures.$inferInsert;

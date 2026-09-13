import { sql } from 'drizzle-orm';
import { bigint, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { media } from '../schemas';

export const FILE_STATUSES = ['pending', 'ready', 'failed', 'deleted'] as const;

export const files = media.table('files', {
  id: uuid('id').primaryKey().defaultRandom(),

  storageKey: text('storage_key').notNull().unique(),
  bucket: text('bucket').notNull(),

  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  checksum: text('checksum'),

  status: text('status', { enum: FILE_STATUSES }).notNull().default('pending'),

  expiresAt: timestamp('expires_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  uniqueIndex('files_checksum_unq').on(table.checksum).where(sql`${table.checksum} IS NOT NULL AND ${table.deletedAt} IS NULL`),
  index('files_status_idx').on(table.status),
  index('files_expires_at_idx').on(table.expiresAt),
]);

export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;
export type FileStatus = (typeof FILE_STATUSES)[number];

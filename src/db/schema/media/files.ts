import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { CHECKSUM_ALGORITHMS, FILE_STATUSES } from '@/constants/media';
import { media } from '../schemas';

export const files = media.table('files', {
  id: uuid('id').primaryKey().defaultRandom(),

  storageKey: text('storage_key'),
  bucket: text('bucket'),
  publicUrl: text('public_url'),
  isPublic: boolean('is_public').notNull().default(false),

  contentType: text('content_type').notNull().default('application/octet-stream'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  checksum: text('checksum'),
  checksumAlgorithm: text('checksum_algorithm', { enum: CHECKSUM_ALGORITHMS }),

  status: text('status', { enum: FILE_STATUSES }).notNull().default('pending'),

  expiresAt: timestamp('expires_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  uniqueIndex('files_storage_key_unq').on(table.storageKey).where(sql`${table.storageKey} IS NOT NULL AND ${table.deletedAt} IS NULL`),
  uniqueIndex('files_checksum_unq').on(table.checksum).where(sql`${table.checksum} IS NOT NULL AND ${table.deletedAt} IS NULL`),
  index('files_status_idx').on(table.status),
  index('files_expires_at_idx').on(table.expiresAt),
  index('files_public_url_idx').on(table.publicUrl).where(sql`${table.publicUrl} IS NOT NULL`),
  check('files_source_check', sql`${table.storageKey} IS NOT NULL OR ${table.publicUrl} IS NOT NULL`),
]);

export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;
export type FileStatus = (typeof FILE_STATUSES)[number];
export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number];

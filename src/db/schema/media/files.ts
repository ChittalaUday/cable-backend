import { sql } from 'drizzle-orm';
import { bigint, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { media } from '../schemas';

/**
 * `pending` means an upload URL was issued but the object is unconfirmed.
 * A row never reaches `ready` until the object is verified present in storage —
 * otherwise a client that abandons an upload leaves a record pointing at nothing.
 */
export const FILE_STATUSES = ['pending', 'ready', 'failed', 'deleted'] as const;

/**
 * Physical objects in storage (Cloudflare R2 / S3).
 *
 * Deduplicated by content checksum (SHA-256). If multiple users or tenants upload
 * the exact same bytes, only one physical object is stored in the bucket and tracked
 * in this table. User/tenant-specific references and metadata live in `media.user_files`.
 */
export const files = media.table('files', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Object key in the bucket. Server-generated — never a client-supplied path. */
  storageKey: text('storage_key').notNull().unique(),
  bucket: text('bucket').notNull(),

  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  /** sha-256 of the content. Primary deduplication key across all uploads. */
  checksum: text('checksum'),

  status: text('status', { enum: FILE_STATUSES }).notNull().default('pending'),

  /** Set for temporary artefacts (exports, one-off reports) so cleanup is a query. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete: the row outlives the object, so a dangling reference is explicable. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  uniqueIndex('files_checksum_unq').on(table.checksum).where(sql`${table.checksum} IS NOT NULL AND ${table.deletedAt} IS NULL`),
  index('files_status_idx').on(table.status),
  index('files_expires_at_idx').on(table.expiresAt),
]);

export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;
export type FileStatus = (typeof FILE_STATUSES)[number];

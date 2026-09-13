import { bigint, index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { media } from './schemas';
import { tenants } from './tenants';
import { users } from './users';

/** Where the file came from. */
export const FILE_KINDS = ['upload', 'generated'] as const;

/**
 * `pending` means an upload URL was issued but the object is unconfirmed.
 * A row never reaches `ready` until the object is verified present in storage —
 * otherwise a client that abandons an upload leaves a record pointing at nothing.
 */
export const FILE_STATUSES = ['pending', 'ready', 'failed', 'deleted'] as const;

export const FILE_VISIBILITIES = ['private', 'public'] as const;

/**
 * Metadata for one object in storage (AGENTS.md §8.4).
 *
 * The bytes are in Cloudflare R2 and never flow through this process: the client
 * uploads to a presigned URL and downloads from one. This table is the index
 * over them, and the only thing that knows an object exists.
 */
export const files = media.table('files', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Null for platform-level assets that belong to no tenant. */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  /** Null when the backend generated the file rather than a person uploading it. */
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),

  /** Object key in the bucket. Server-generated — never a client-supplied path. */
  storageKey: text('storage_key').notNull().unique(),
  bucket: text('bucket').notNull(),

  /** What the user called it. Display only; never used to build the key. */
  originalName: text('original_name'),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  /** sha-256 of the content, when known. Integrity check and dedup candidate. */
  checksum: text('checksum'),

  kind: text('kind', { enum: FILE_KINDS }).notNull().default('upload'),
  status: text('status', { enum: FILE_STATUSES }).notNull().default('pending'),
  visibility: text('visibility', { enum: FILE_VISIBILITIES }).notNull().default('private'),

  /** Dimensions, page count, duration — whatever the type makes useful. */
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  /** Set for temporary artefacts (exports, one-off reports) so cleanup is a query. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete: the row outlives the object, so a dangling reference is explicable. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('files_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('files_status_idx').on(table.status),
  index('files_expires_at_idx').on(table.expiresAt),
]);

export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;
export type FileKind = (typeof FILE_KINDS)[number];
export type FileStatus = (typeof FILE_STATUSES)[number];
export type FileVisibility = (typeof FILE_VISIBILITIES)[number];

// Domain tables reference a file by id (`customers.photo_file_id`), which keeps
// a real foreign key. If many-to-many attachments become necessary (a ticket
// with several photos), add a `media.attachments` link table then — a
// polymorphic owner_type/owner_id pair here would buy flexibility nothing needs
// yet at the cost of every FK guarantee.

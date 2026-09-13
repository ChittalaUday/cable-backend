import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { media } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { files } from './files';

/** Where the file came from. */
export const FILE_KINDS = ['upload', 'generated'] as const;
export const FILE_VISIBILITIES = ['private', 'public'] as const;

/**
 * Tenant and user metadata for an uploaded file.
 *
 * Maps a user's original filename and ownership to a deduplicated physical asset in `media.files`.
 * Multiple user files can point to the same physical file if the content hash matches.
 */
export const userFiles = media.table('user_files', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Null for platform-level assets that belong to no tenant. */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  /** Null when the backend generated the file rather than a person uploading it. */
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),

  /** Foreign key pointing to the physical storage asset. */
  fileId: uuid('file_id').notNull().references(() => files.id, { onDelete: 'restrict' }),

  /** What the user called it. Display only; never used to build the key. */
  originalName: text('original_name').notNull(),

  kind: text('kind', { enum: FILE_KINDS }).notNull().default('upload'),
  visibility: text('visibility', { enum: FILE_VISIBILITIES }).notNull().default('private'),

  /** Dimensions, page count, duration — whatever the type makes useful. */
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete: the row outlives the object, so a dangling reference is explicable. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  index('user_files_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('user_files_file_idx').on(table.fileId),
  index('user_files_uploaded_by_idx').on(table.uploadedBy),
]);

export type UserFileRecord = typeof userFiles.$inferSelect;
export type NewUserFileRecord = typeof userFiles.$inferInsert;
export type FileKind = (typeof FILE_KINDS)[number];
export type FileVisibility = (typeof FILE_VISIBILITIES)[number];

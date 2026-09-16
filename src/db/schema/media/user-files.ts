import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { FILE_KINDS, FILE_VISIBILITIES } from '@/shared/constants/media';
import { users } from '../auth/users';
import { media } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { files } from './files';

export const userFiles = media.table('user_files', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),

  fileId: uuid('file_id').notNull().references(() => files.id, { onDelete: 'restrict' }),

  originalName: text('original_name').notNull(),

  kind: text('kind', { enum: FILE_KINDS }).notNull().default('upload'),
  visibility: text('visibility', { enum: FILE_VISIBILITIES }).notNull().default('private'),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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

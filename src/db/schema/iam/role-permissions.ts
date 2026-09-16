import { sql } from 'drizzle-orm';
import { check, primaryKey, text } from 'drizzle-orm/pg-core';
import { PERMISSION_SCOPES } from '@/security/permissions';
import { iam } from '../schemas';
import { roles } from './roles';

export const rolePermissions = iam.table('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionKey: text('permission_key').notNull(),
  scope: text('scope', { enum: PERMISSION_SCOPES }).notNull(),
}, table => [
  primaryKey({ columns: [table.roleId, table.permissionKey] }),
  check('role_permissions_known_scope', sql.raw(`"scope" IN (${PERMISSION_SCOPES.map(scope => `'${scope}'`).join(', ')})`)),
]);

export type RolePermission = typeof rolePermissions.$inferSelect;

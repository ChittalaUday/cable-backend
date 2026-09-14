import { sql } from 'drizzle-orm';
import { check, primaryKey, text } from 'drizzle-orm/pg-core';
import { PERMISSION_SCOPES } from '@/shared/security/permissions';
import { iam } from '../schemas';
import { roles } from './roles';

export const rolePermissions = iam.table('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionKey: text('permission_key').notNull(),
  scope: text('scope', { enum: PERMISSION_SCOPES }).notNull(),
}, table => [
  primaryKey({ columns: [table.roleId, table.permissionKey] }),
  // Built from the same array the column's enum uses. Spelling the list out
  // twice is how the constraint ends up allowing a scope the code retired.
  //
  // `sql.raw`, not an interpolation: a bound parameter is legal in a query and
  // not in DDL, so `sql`${scope}`` would emit `IN ($1, $2, ...)` into the
  // generated migration. The values are compile-time constants from this repo.
  check('role_permissions_known_scope', sql.raw(`"scope" IN (${PERMISSION_SCOPES.map(scope => `'${scope}'`).join(', ')})`)),
]);

export type RolePermission = typeof rolePermissions.$inferSelect;

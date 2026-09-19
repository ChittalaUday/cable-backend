import type { SystemRoleId } from '@/config/constants';
import type { Database } from '@/db/client';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { rolePermissions, roles } from '@/db/schema';
import { ROLE_NAMES, SYSTEM_ROLE_GRANTS } from '@/security/role-grants';

/** The seeds build their handle with and without the schema generic; both do. */
type RoleWriter = Pick<Database, 'insert' | 'delete' | 'select'>;

/**
 * Bring `iam.roles` and `iam.role_permissions` in line with the shipped matrix.
 *
 * This reconciles rather than tops up. An upsert alone leaves a grant that has
 * been taken out of `SYSTEM_ROLE_GRANTS` sitting in the database, so tightening
 * a role in code would tighten nothing in any environment the seed had already
 * touched — the role would keep the wider permission for good.
 *
 * Roles are global, not per tenant: a new tenant needs no roles of its own, but
 * it does need these to exist, or every membership in it resolves to no
 * permissions at all.
 */
export async function ensureSystemRoles(db: RoleWriter): Promise<{ granted: number; revoked: number }> {
  let granted = 0;
  let revoked = 0;

  for (const roleId of Object.keys(SYSTEM_ROLE_GRANTS) as SystemRoleId[]) {
    const grants = SYSTEM_ROLE_GRANTS[roleId];

    await db
      .insert(roles)
      .values({ id: roleId, name: ROLE_NAMES[roleId] })
      .onConflictDoUpdate({ target: roles.id, set: { name: ROLE_NAMES[roleId], updatedAt: new Date() } });

    await db
      .insert(rolePermissions)
      .values(grants.map(([permissionKey, scope]) => ({ roleId, permissionKey, scope })))
      .onConflictDoUpdate({
        target: [rolePermissions.roleId, rolePermissions.permissionKey],
        set: { scope: sql`excluded.scope` },
      });

    granted += grants.length;

    const stale = await db
      .delete(rolePermissions)
      .where(and(
        eq(rolePermissions.roleId, roleId),
        notInArray(rolePermissions.permissionKey, grants.map(([key]) => key)),
      ))
      .returning({ key: rolePermissions.permissionKey });

    revoked += stale.length;
  }

  // A role id outside the matrix cannot be reached by any membership, and the
  // table's check constraint already refuses one — but a leftover row would
  // still carry grants, so it goes too.
  await db
    .delete(rolePermissions)
    .where(notInArray(rolePermissions.roleId, Object.keys(SYSTEM_ROLE_GRANTS)));

  await db
    .delete(roles)
    .where(notInArray(roles.id, Object.keys(SYSTEM_ROLE_GRANTS)));

  return { granted, revoked };
}

/** Roles a tenant needs before anybody can be given a membership in it. */
export async function assertSystemRolesPresent(db: RoleWriter): Promise<void> {
  const present = await db
    .select({ id: roles.id })
    .from(roles)
    .where(inArray(roles.id, Object.keys(SYSTEM_ROLE_GRANTS)));

  const missing = Object.keys(SYSTEM_ROLE_GRANTS).filter(id => !present.some(row => row.id === id));

  if (missing.length > 0)
    throw new Error(`System roles are missing: ${missing.join(', ')}. Run \`pnpm db:seed\` first.`);
}

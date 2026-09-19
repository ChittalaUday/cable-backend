import type { PermissionKey, PermissionScope } from './permissions';
import type { SystemRoleId } from '@/config/constants';
import { SYSTEM_ROLES } from '@/config/constants';
import { ALL_PERMISSION_KEYS, PERMISSIONS } from './permissions';

export type Grant = readonly [PermissionKey, PermissionScope];

/**
 * What each system role may do, and how far.
 *
 * This is the shipped authorization matrix. The seed writes it to
 * `iam.role_permissions`, and `permission-matrix.api.test.ts` drives every route
 * against it — so a permission added to a route without a grant here fails the
 * build rather than 403-ing in production.
 */
export const SYSTEM_ROLE_GRANTS: Readonly<Record<SystemRoleId, readonly Grant[]>> = {
  [SYSTEM_ROLES.ADMIN]: ALL_PERMISSION_KEYS.map(key => [key, 'ALL'] as const),

  [SYSTEM_ROLES.STAFF]: [
    [PERMISSIONS.CUSTOMERS_VIEW, 'LOCATION'],
    [PERMISSIONS.CUSTOMERS_CREATE, 'LOCATION'],
    [PERMISSIONS.CUSTOMERS_UPDATE, 'LOCATION'],
    [PERMISSIONS.LOCATIONS_VIEW, 'LOCATION'],
    [PERMISSIONS.LOCATIONS_CREATE, 'LOCATION'],
    [PERMISSIONS.LOCATIONS_UPDATE, 'LOCATION'],
    [PERMISSIONS.LOCATIONS_DELETE, 'LOCATION'],
    [PERMISSIONS.CONNECTIONS_VIEW, 'LOCATION'],
    [PERMISSIONS.CONNECTIONS_CREATE, 'LOCATION'],
    [PERMISSIONS.CONNECTIONS_UPDATE, 'LOCATION'],
    [PERMISSIONS.PAYMENTS_VIEW, 'LOCATION'],
    [PERMISSIONS.PAYMENTS_COLLECT, 'LOCATION'],
    [PERMISSIONS.TICKETS_VIEW, 'ASSIGNED'],
    [PERMISSIONS.TICKETS_CREATE, 'LOCATION'],
    [PERMISSIONS.TICKETS_UPDATE, 'ASSIGNED'],
    [PERMISSIONS.TICKETS_RESOLVE, 'ASSIGNED'],
    [PERMISSIONS.INVENTORY_VIEW, 'LOCATION'],
    [PERMISSIONS.INVENTORY_UPDATE, 'LOCATION'],
    // Fitting and collecting a set-top box is the field job. The service checks
    // the customer is inside the engineer's areas before either.
    [PERMISSIONS.INVENTORY_ISSUE, 'LOCATION'],
    [PERMISSIONS.PACKAGES_VIEW, 'LOCATION'],
    [PERMISSIONS.SERVICES_VIEW, 'LOCATION'],
    [PERMISSIONS.REPORTS_VIEW, 'LOCATION'],
    [PERMISSIONS.REMOTES_VIEW, 'ALL'],
    [PERMISSIONS.REMOTES_MANAGE, 'ALL'],
    [PERMISSIONS.NOTIFICATIONS_SEND, 'ALL'],
  ],

  [SYSTEM_ROLES.CUSTOMER]: [
    [PERMISSIONS.CUSTOMERS_VIEW, 'OWN'],
    [PERMISSIONS.CONNECTIONS_VIEW, 'OWN'],
    [PERMISSIONS.PAYMENTS_VIEW, 'OWN'],
    [PERMISSIONS.TICKETS_VIEW, 'OWN'],
    [PERMISSIONS.TICKETS_CREATE, 'OWN'],
    [PERMISSIONS.PACKAGES_VIEW, 'ALL'],
    [PERMISSIONS.SERVICES_VIEW, 'ALL'],
    [PERMISSIONS.DEVICES_VIEW, 'OWN'],
    [PERMISSIONS.SESSIONS_VIEW, 'OWN'],
    [PERMISSIONS.SESSIONS_REVOKE, 'OWN'],
    [PERMISSIONS.REMOTES_VIEW, 'ALL'],
  ],
};

export const ROLE_NAMES: Readonly<Record<SystemRoleId, string>> = {
  [SYSTEM_ROLES.ADMIN]: 'Admin',
  [SYSTEM_ROLES.STAFF]: 'Staff',
  [SYSTEM_ROLES.CUSTOMER]: 'Customer',
};

export function grantsOf(roleId: SystemRoleId): ReadonlyMap<PermissionKey, PermissionScope> {
  return new Map(SYSTEM_ROLE_GRANTS[roleId].map(([key, scope]) => [key, scope]));
}

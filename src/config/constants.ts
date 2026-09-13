/** App-wide constants (AGENTS.md §3). Values that are policy, not configuration. */

/** `limit` ceiling on every list endpoint, enforced by TypeBox `maximum` (§6). */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

/** Header carrying the active tenant (§4.4). */
export const TENANT_HEADER = 'x-tenant-id';

/** Device headers (§4.6). */
export const DEVICE_ID_HEADER = 'x-device-id';
export const PLATFORM_HEADER = 'x-platform';
export const APP_VERSION_HEADER = 'x-app-version';
export const OS_VERSION_HEADER = 'x-os-version';
export const DEVICE_MODEL_HEADER = 'x-device-model';

/** System role ids (§4.2). Seeded, never invented at runtime. */
export const SYSTEM_ROLES = {
  ADMIN: 'admin',
  STAFF: 'staff',
  CUSTOMER: 'customer',
} as const;

export type SystemRoleId = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/** Tenant prefix shape (§8.1). */
export const TENANT_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/;
export const CUSTOMER_SEQ_PAD = 6;

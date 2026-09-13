export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}` as const;

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

export const TENANT_HEADER = 'x-tenant-id';

export const DEVICE_ID_HEADER = 'x-device-id';
export const PLATFORM_HEADER = 'x-platform';
export const APP_VERSION_HEADER = 'x-app-version';
export const OS_VERSION_HEADER = 'x-os-version';
export const DEVICE_MODEL_HEADER = 'x-device-model';

export const SYSTEM_ROLES = {
  ADMIN: 'admin',
  STAFF: 'staff',
  CUSTOMER: 'customer',
} as const;

export type SystemRoleId = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

export const TENANT_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/;
export const CUSTOMER_SEQ_PAD = 6;

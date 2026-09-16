export const LOCATION_SOURCES = ['system', 'admin', 'user', 'import'] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

export const LOCATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

export const LOCATION_ALIAS_SOURCES = ['admin', 'import'] as const;
export type LocationAliasSource = (typeof LOCATION_ALIAS_SOURCES)[number];

export const LOCATION_WRITABLE_STATUSES = ['pending', 'approved'] as const satisfies readonly LocationStatus[];
export type LocationWritableStatus = (typeof LOCATION_WRITABLE_STATUSES)[number];

export const LOCATION_SOURCE = {
  SYSTEM: 'system',
  ADMIN: 'admin',
  USER: 'user',
  IMPORT: 'import',
} as const satisfies Record<string, LocationSource>;

export const LOCATION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const satisfies Record<string, LocationStatus>;

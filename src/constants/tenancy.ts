export const TENANT_STATUSES = ['active', 'suspended'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'invited', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const MEMBERSHIP_SETTABLE_STATUSES = ['active', 'invited'] as const satisfies readonly MembershipStatus[];
export type MembershipSettableStatus = (typeof MEMBERSHIP_SETTABLE_STATUSES)[number];

export const TENANT_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const satisfies Record<string, TenantStatus>;

export const MEMBERSHIP_STATUS = {
  ACTIVE: 'active',
  INVITED: 'invited',
  SUSPENDED: 'suspended',
} as const satisfies Record<string, MembershipStatus>;

export const ENTITY_STATUSES = ['active', 'inactive'] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

export const CUSTOMER_STATUSES = ['active', 'inactive', 'pending'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const PACKAGE_TYPES = ['base', 'bouquet', 'addon', 'ala_carte', 'combo'] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

export const CHANNEL_GENRES = [
  'Entertainment',
  'Movies',
  'News',
  'Sports',
  'Music',
  'Kids',
  'Infotainment',
  'Devotional',
  'General',
] as const;
export type ChannelGenre = (typeof CHANNEL_GENRES)[number];

export const CHANNEL_RESOLUTIONS = ['SD', 'HD', '4K'] as const;
export type ChannelResolution = (typeof CHANNEL_RESOLUTIONS)[number];

export const BILLING_CYCLES = ['monthly', 'quarterly', 'semi_annual', 'annual'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'inactive', 'suspended', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const TRANSACTION_TYPES = [
  'deduction',
  'deposit',
  'reversal',
  'adjustment',
  'other',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const CUSTOMER_LOCATION_SOURCES = ['customer', 'subscription'] as const;
export type CustomerLocationSource = (typeof CUSTOMER_LOCATION_SOURCES)[number];

export const ENTITY_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const satisfies Record<string, EntityStatus>;

export const CUSTOMER_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  PENDING: 'pending',
} as const satisfies Record<string, CustomerStatus>;

export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
} as const satisfies Record<string, SubscriptionStatus>;

export const PACKAGE_TYPE = {
  BASE: 'base',
  BOUQUET: 'bouquet',
  ADDON: 'addon',
  ALA_CARTE: 'ala_carte',
  COMBO: 'combo',
} as const satisfies Record<string, PackageType>;

export const BILLING_CYCLE = {
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  SEMI_ANNUAL: 'semi_annual',
  ANNUAL: 'annual',
} as const satisfies Record<string, BillingCycle>;

export const TRANSACTION_TYPE = {
  DEDUCTION: 'deduction',
  DEPOSIT: 'deposit',
  REVERSAL: 'reversal',
  ADJUSTMENT: 'adjustment',
  OTHER: 'other',
} as const satisfies Record<string, TransactionType>;

export const TICKET_CATEGORIES = [
  'no_signal',
  'poor_quality',
  'billing',
  'installation',
  'relocation',
  'disconnection',
  'other',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed', 'cancelled'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses a ticket is no longer worked on in. */
export const TICKET_CLOSED_STATUSES = ['resolved', 'closed', 'cancelled'] as const;

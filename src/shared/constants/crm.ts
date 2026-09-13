export const SERVICE_TYPES = ['cable', 'broadband', 'iptv', 'voip', 'other'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

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

export const EQUIPMENT_TYPES = [
  'stb',
  'smart_card',
  'ont',
  'router',
  'remote',
  'power_adapter',
  'fiber_node',
  'patch_cable',
  'other',
] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export const EQUIPMENT_STATUSES = [
  'active',
  'standby',
  'faulty',
  'returned',
  'lost_unreturned',
  'written_off',
] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export const EQUIPMENT_INVENTORY_STATUSES = [
  'available',
  'allocated',
  'faulty',
  'retired',
  'lost',
] as const;
export type EquipmentInventoryStatus = (typeof EQUIPMENT_INVENTORY_STATUSES)[number];

export const EQUIPMENT_OWNERSHIPS = [
  'tenant_provided',
  'customer_owned',
  'rental',
  'deposit',
] as const;
export type EquipmentOwnership = (typeof EQUIPMENT_OWNERSHIPS)[number];

export const EQUIPMENT_RETURN_CONDITIONS = [
  'working',
  'damaged',
  'missing_accessories',
  'faulty',
] as const;
export type EquipmentReturnCondition = (typeof EQUIPMENT_RETURN_CONDITIONS)[number];

export const TRANSACTION_TYPES = [
  'deduction',
  'deposit',
  'reversal',
  'adjustment',
  'other',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

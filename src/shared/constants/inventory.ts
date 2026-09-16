export const DEFAULT_ITEM_TYPES = [
  { code: 'stb', name: 'Set Top Box', icon: 'tv-01', isSerialized: true, isReturnable: true },
  { code: 'smart_card', name: 'Smart Card / VC', icon: 'credit-card-pos', isSerialized: true, isReturnable: true },
  { code: 'ont', name: 'Optical Network Terminal (ONT)', icon: 'router-01', isSerialized: true, isReturnable: true },
  { code: 'router', name: 'Wi-Fi Router', icon: 'wifi-01', isSerialized: true, isReturnable: true },
  { code: 'remote', name: 'Remote Control', icon: 'remote-controller-01', isSerialized: false, isReturnable: true },
  { code: 'power_adapter', name: 'Power Adapter', icon: 'plug-socket', isSerialized: false, isReturnable: true },
  { code: 'fiber_node', name: 'Fiber to Coax Mini Node', icon: 'cpu', isSerialized: true, isReturnable: true },
  { code: 'patch_cable', name: 'Fiber Patch Cord', icon: 'cable-01', isSerialized: false, isReturnable: false },
  { code: 'hdmi_cable', name: 'HDMI Cable', icon: 'cable-02', isSerialized: false, isReturnable: false },
  { code: 'rca_cable', name: 'AV / RCA Cable', icon: 'cable-01', isSerialized: false, isReturnable: false },
  { code: 'splitter', name: 'Splitter / Coupler', icon: 'git-fork', isSerialized: false, isReturnable: false },
  { code: 'user_manual', name: 'User Manual & Packaging', icon: 'book-02', isSerialized: false, isReturnable: false },
  { code: 'accessory', name: 'General Accessory', icon: 'package', isSerialized: false, isReturnable: true },
] as const;

export const TRACKING_TYPES = ['serialized', 'quantity'] as const;
export type TrackingType = (typeof TRACKING_TYPES)[number];

export const EQUIPMENT_OWNERSHIPS = [
  'tenant_provided',
  'customer_owned',
  'rental',
  'deposit',
] as const;
export type EquipmentOwnership = (typeof EQUIPMENT_OWNERSHIPS)[number];

export const INVENTORY_STATUSES = [
  'available',
  'staff_van',
  'allocated',
  'faulty',
  'under_repair',
  'retired',
  'sold',
  'lost',
] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const CUSTOMER_EQUIPMENT_STATUSES = [
  'active',
  'standby',
  'faulty',
  'returned',
  'replaced',
  'lost_unreturned',
  'written_off',
] as const;
export type CustomerEquipmentStatus = (typeof CUSTOMER_EQUIPMENT_STATUSES)[number];

export const EQUIPMENT_RETURN_CONDITIONS = [
  'working',
  'damaged',
  'missing_accessories',
  'faulty',
] as const;
export type EquipmentReturnCondition = (typeof EQUIPMENT_RETURN_CONDITIONS)[number];

export const STOCK_MOVEMENT_TYPES = [
  'inward',
  'transfer',
  'van_checkout',
  'van_checkin',
  'customer_issue',
  'customer_return',
  'swap',
  'repair_out',
  'repair_return',
  'scrap',
  'adjustment',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const INVENTORY_REQUEST_TYPES = ['create_item', 'update_item', 'delete_item', 'adjust_stock'] as const;
export type InventoryRequestType = (typeof INVENTORY_REQUEST_TYPES)[number];

export const INVENTORY_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type InventoryRequestStatus = (typeof INVENTORY_REQUEST_STATUSES)[number];

export const INVENTORY_REVIEW_OUTCOMES = ['approved', 'rejected'] as const satisfies readonly InventoryRequestStatus[];
export type InventoryReviewOutcome = (typeof INVENTORY_REVIEW_OUTCOMES)[number];

export const STOCK_LEVEL_FILTERS = ['all', 'in_stock', 'low_stock'] as const;
export type StockLevelFilter = (typeof STOCK_LEVEL_FILTERS)[number];

export const INVENTORY_LOOKUP_TYPES = ['equipment', 'catalog'] as const;
export type InventoryLookupType = (typeof INVENTORY_LOOKUP_TYPES)[number];

export const INVENTORY_STATUS = {
  AVAILABLE: 'available',
  STAFF_VAN: 'staff_van',
  ALLOCATED: 'allocated',
  FAULTY: 'faulty',
  UNDER_REPAIR: 'under_repair',
  RETIRED: 'retired',
  SOLD: 'sold',
  LOST: 'lost',
} as const satisfies Record<string, InventoryStatus>;

export const CUSTOMER_EQUIPMENT_STATUS = {
  ACTIVE: 'active',
  STANDBY: 'standby',
  FAULTY: 'faulty',
  RETURNED: 'returned',
  REPLACED: 'replaced',
  LOST_UNRETURNED: 'lost_unreturned',
  WRITTEN_OFF: 'written_off',
} as const satisfies Record<string, CustomerEquipmentStatus>;

export const STOCK_MOVEMENT_TYPE = {
  INWARD: 'inward',
  TRANSFER: 'transfer',
  VAN_CHECKOUT: 'van_checkout',
  VAN_CHECKIN: 'van_checkin',
  CUSTOMER_ISSUE: 'customer_issue',
  CUSTOMER_RETURN: 'customer_return',
  SWAP: 'swap',
  REPAIR_OUT: 'repair_out',
  REPAIR_RETURN: 'repair_return',
  SCRAP: 'scrap',
  ADJUSTMENT: 'adjustment',
} as const satisfies Record<string, StockMovementType>;

export const EQUIPMENT_OWNERSHIP = {
  TENANT_PROVIDED: 'tenant_provided',
  CUSTOMER_OWNED: 'customer_owned',
  RENTAL: 'rental',
  DEPOSIT: 'deposit',
} as const satisfies Record<string, EquipmentOwnership>;

export const TRACKING_TYPE = {
  SERIALIZED: 'serialized',
  QUANTITY: 'quantity',
} as const satisfies Record<string, TrackingType>;

export const INVENTORY_REQUEST_TYPE = {
  CREATE_ITEM: 'create_item',
  UPDATE_ITEM: 'update_item',
  DELETE_ITEM: 'delete_item',
  ADJUST_STOCK: 'adjust_stock',
} as const satisfies Record<string, InventoryRequestType>;

export const INVENTORY_REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const satisfies Record<string, InventoryRequestStatus>;

export const STOCK_LEVEL_FILTER = {
  ALL: 'all',
  IN_STOCK: 'in_stock',
  LOW_STOCK: 'low_stock',
} as const satisfies Record<string, StockLevelFilter>;

export const INVENTORY_LOOKUP_TYPE = {
  EQUIPMENT: 'equipment',
  CATALOG: 'catalog',
} as const satisfies Record<string, InventoryLookupType>;

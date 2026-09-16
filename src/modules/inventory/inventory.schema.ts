import type { Static } from 'typebox';
import { Type } from 'typebox';
import {
  CUSTOMER_EQUIPMENT_STATUSES,
  EQUIPMENT_OWNERSHIPS,
  INVENTORY_LOOKUP_TYPES,
  INVENTORY_REQUEST_TYPES,
  INVENTORY_REVIEW_OUTCOMES,
  INVENTORY_STATUSES,
  STOCK_LEVEL_FILTERS,
  STOCK_MOVEMENT_TYPES,
  TRACKING_TYPES,
} from '@/shared/constants/inventory';
import { StringEnum, StringEnumWithDefault } from '@/shared/types/typebox';

export const IdParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

export const LocationQuery = Type.Object({
  locationId: Type.Optional(Type.String({ format: 'uuid' })),
});

export const ListStockQuery = Type.Object({
  locationId: Type.Optional(Type.String({ format: 'uuid' })),
  status: Type.Optional(StringEnum(STOCK_LEVEL_FILTERS)),
  search: Type.Optional(Type.String()),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
});

export const StockItemResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  code: Type.Union([Type.String(), Type.Null()]),
  brand: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  itemType: Type.String(),
  trackingType: StringEnum(TRACKING_TYPES),
  isBundle: Type.Boolean(),
  defaultOwnership: StringEnum(EQUIPMENT_OWNERSHIPS),
  defaultSalePrice: Type.String(),
  defaultDepositAmount: Type.String(),
  defaultRentalPrice: Type.String(),
  isReturnable: Type.Boolean(),
  icon: Type.Union([Type.String(), Type.Null()]),
  description: Type.Union([Type.String(), Type.Null()]),

  totalStock: Type.Integer(),
  availableStock: Type.Integer(),
  issuedStock: Type.Integer(),
  inTransitStock: Type.Integer(),
  locationId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  locationName: Type.Union([Type.String(), Type.Null()]),
});

export const LowStockItem = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  code: Type.Union([Type.String(), Type.Null()]),
  availableStock: Type.Integer(),
  totalStock: Type.Integer(),
});

export const RecentMovement = Type.Object({
  id: Type.String({ format: 'uuid' }),
  movementType: StringEnum(STOCK_MOVEMENT_TYPES),
  itemName: Type.String(),
  itemCode: Type.Union([Type.String(), Type.Null()]),
  targetName: Type.Union([Type.String(), Type.Null()]),
  fromLocationName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  toLocationName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  quantity: Type.Integer(),
  performedByName: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
});

export const InventoryLocationResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  code: Type.Union([Type.String(), Type.Null()]),
  itemCount: Type.Optional(Type.Integer()),
});

export const InventoryDashboardResponse = Type.Object({
  locationId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  locationName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  totalItems: Type.Integer(),
  inStock: Type.Integer(),
  issued: Type.Integer(),
  inTransit: Type.Integer(),
  lowStockItems: Type.Array(LowStockItem),
  recentMovements: Type.Array(RecentMovement),
});

export const SerializedUnit = Type.Object({
  id: Type.String({ format: 'uuid' }),
  serialNumber: Type.Union([Type.String(), Type.Null()]),
  vcNumber: Type.Union([Type.String(), Type.Null()]),
  macAddress: Type.Union([Type.String(), Type.Null()]),
  barcode: Type.Union([Type.String(), Type.Null()]),
  inventoryStatus: StringEnum(INVENTORY_STATUSES),
  locationName: Type.Union([Type.String(), Type.Null()]),
  staffName: Type.Union([Type.String(), Type.Null()]),
});

export const BundleComponent = Type.Object({
  componentId: Type.String({ format: 'uuid' }),
  name: Type.String(),
  code: Type.Union([Type.String(), Type.Null()]),
  quantity: Type.Integer(),
  isOptional: Type.Boolean(),
});

export const ItemDetailsResponse = Type.Intersect([
  StockItemResponse,
  Type.Object({
    units: Type.Array(SerializedUnit),
    bundleComponents: Type.Array(BundleComponent),
  }),
]);

export const CreateCatalogItemBody = Type.Object({
  name: Type.String({ minLength: 2, maxLength: 100 }),
  code: Type.Optional(Type.String({ maxLength: 50 })),
  brand: Type.Optional(Type.String({ maxLength: 50 })),
  model: Type.Optional(Type.String({ maxLength: 50 })),
  itemType: Type.Optional(Type.String({ default: 'other' })),
  trackingType: Type.Optional(StringEnumWithDefault(TRACKING_TYPES, 'serialized')),
  isBundle: Type.Optional(Type.Boolean({ default: false })),
  defaultOwnership: Type.Optional(StringEnumWithDefault(EQUIPMENT_OWNERSHIPS, 'tenant_provided')),
  defaultSalePrice: Type.Optional(Type.String({ default: '0' })),
  defaultDepositAmount: Type.Optional(Type.String({ default: '0' })),
  defaultRentalPrice: Type.Optional(Type.String({ default: '0' })),
  isReturnable: Type.Optional(Type.Boolean({ default: true })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
});

export const UpdateCatalogItemBody = Type.Partial(CreateCatalogItemBody);

export const IssueEquipmentBody = Type.Object({
  customerId: Type.String({ format: 'uuid' }),
  subscriptionId: Type.Optional(Type.String({ format: 'uuid' })),
  catalogId: Type.String({ format: 'uuid' }),
  equipmentId: Type.Optional(Type.String({ format: 'uuid' })),
  serialNumber: Type.Optional(Type.String()),
  ownershipType: Type.Optional(StringEnumWithDefault(EQUIPMENT_OWNERSHIPS, 'tenant_provided')),
  chargedAmount: Type.Optional(Type.String({ default: '0' })),
  depositAmount: Type.Optional(Type.String({ default: '0' })),
  notes: Type.Optional(Type.String()),
});

export const IssueEquipmentResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  equipmentId: Type.String({ format: 'uuid' }),
  customerId: Type.String({ format: 'uuid' }),
  customerName: Type.String(),
  customerCode: Type.Union([Type.String(), Type.Null()]),
  subscriptionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  itemName: Type.String(),
  itemCode: Type.Union([Type.String(), Type.Null()]),
  serialNumber: Type.Union([Type.String(), Type.Null()]),
  status: StringEnum(CUSTOMER_EQUIPMENT_STATUSES),
  ownershipType: StringEnum(EQUIPMENT_OWNERSHIPS),
  assignedAt: Type.String({ format: 'date-time' }),
});

export const CreateApprovalRequestBody = Type.Object({
  requestType: StringEnum(INVENTORY_REQUEST_TYPES),
  targetItemId: Type.Optional(Type.String({ format: 'uuid' })),
  proposedData: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
});

export const ReviewApprovalRequestBody = Type.Object({
  status: StringEnum(INVENTORY_REVIEW_OUTCOMES),
  reviewNotes: Type.Optional(Type.String({ maxLength: 500 })),
});

export const ApprovalRequestResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  requestedBy: Type.String({ format: 'uuid' }),
  requestedByName: Type.Union([Type.String(), Type.Null()]),
  requestType: Type.String(),
  targetItemId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  targetItemName: Type.Union([Type.String(), Type.Null()]),
  proposedData: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  reason: Type.String(),
  status: Type.String(),
  reviewedBy: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  reviewedByName: Type.Union([Type.String(), Type.Null()]),
  reviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  reviewNotes: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
});

export const StockMovementResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  equipmentId: Type.String({ format: 'uuid' }),
  movementType: StringEnum(STOCK_MOVEMENT_TYPES),
  itemName: Type.String(),
  itemCode: Type.Union([Type.String(), Type.Null()]),
  serialNumber: Type.Union([Type.String(), Type.Null()]),
  fromLocationName: Type.Union([Type.String(), Type.Null()]),
  toLocationName: Type.Union([Type.String(), Type.Null()]),
  fromStaffName: Type.Union([Type.String(), Type.Null()]),
  toStaffName: Type.Union([Type.String(), Type.Null()]),
  performedByName: Type.Union([Type.String(), Type.Null()]),
  quantity: Type.Integer(),
  notes: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
});

export const DeleteResponse = Type.Object({
  success: Type.Literal(true),
});

export const LookupQuery = Type.Object({
  q: Type.String({ minLength: 1 }),
});

export const LookupItemResponse = Type.Object({
  type: StringEnum(INVENTORY_LOOKUP_TYPES),
  id: Type.String({ format: 'uuid' }),
  catalogId: Type.String({ format: 'uuid' }),
  itemName: Type.String(),
  itemCode: Type.Union([Type.String(), Type.Null()]),
  brand: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  serialNumber: Type.Union([Type.String(), Type.Null()]),
  barcode: Type.Union([Type.String(), Type.Null()]),
  vcNumber: Type.Union([Type.String(), Type.Null()]),
  macAddress: Type.Union([Type.String(), Type.Null()]),
  inventoryStatus: Type.Union([Type.String(), Type.Null()]),
  locationId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  locationName: Type.Union([Type.String(), Type.Null()]),
  defaultSalePrice: Type.String(),
  defaultDepositAmount: Type.String(),
  availableStock: Type.Integer(),
});

export const CustomerEquipmentQuery = Type.Object({
  customerId: Type.Optional(Type.String({ format: 'uuid' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
});

export const CustomerEquipmentItem = Type.Object({
  id: Type.String({ format: 'uuid' }),
  customerId: Type.String({ format: 'uuid' }),
  customerName: Type.String(),
  customerCode: Type.Union([Type.String(), Type.Null()]),
  subscriptionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  equipmentId: Type.String({ format: 'uuid' }),
  itemName: Type.String(),
  itemCode: Type.Union([Type.String(), Type.Null()]),
  serialNumber: Type.Union([Type.String(), Type.Null()]),
  barcode: Type.Union([Type.String(), Type.Null()]),
  vcNumber: Type.Union([Type.String(), Type.Null()]),
  macAddress: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  ownershipType: Type.String(),
  chargedAmount: Type.String(),
  depositAmount: Type.String(),
  assignedAt: Type.String({ format: 'date-time' }),
});

export const InwardStockBody = Type.Object({
  catalogId: Type.String({ format: 'uuid' }),
  locationId: Type.Optional(Type.String({ format: 'uuid' })),
  quantity: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  serialNumbers: Type.Optional(Type.Array(Type.String())),
  costPrice: Type.Optional(Type.String({ default: '0' })),
  depositAmount: Type.Optional(Type.String({ default: '0' })),
  notes: Type.Optional(Type.String()),
});

export const TransferStockBody = Type.Object({
  equipmentId: Type.Optional(Type.String({ format: 'uuid' })),
  catalogId: Type.Optional(Type.String({ format: 'uuid' })),
  fromLocationId: Type.Optional(Type.String({ format: 'uuid' })),
  toLocationId: Type.Optional(Type.String({ format: 'uuid' })),
  toStaffId: Type.Optional(Type.String({ format: 'uuid' })),
  quantity: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  notes: Type.Optional(Type.String()),
});

export type StockItemResponse = Static<typeof StockItemResponse>;
export type ItemDetailsResponse = Static<typeof ItemDetailsResponse>;
export type IssueEquipmentBody = Static<typeof IssueEquipmentBody>;
export type IssueEquipmentResponse = Static<typeof IssueEquipmentResponse>;
export type CreateCatalogItemBody = Static<typeof CreateCatalogItemBody>;
export type UpdateCatalogItemBody = Static<typeof UpdateCatalogItemBody>;
export type CreateApprovalRequestBody = Static<typeof CreateApprovalRequestBody>;
export type ReviewApprovalRequestBody = Static<typeof ReviewApprovalRequestBody>;
export type ListStockQuery = Static<typeof ListStockQuery>;
export type InventoryDashboardResponse = Static<typeof InventoryDashboardResponse>;
export type InventoryLocationResponse = Static<typeof InventoryLocationResponse>;
export type ApprovalRequestResponse = Static<typeof ApprovalRequestResponse>;
export type StockMovementResponse = Static<typeof StockMovementResponse>;
export type LookupQuery = Static<typeof LookupQuery>;
export type LookupItemResponse = Static<typeof LookupItemResponse>;
export type CustomerEquipmentQuery = Static<typeof CustomerEquipmentQuery>;
export type CustomerEquipmentItem = Static<typeof CustomerEquipmentItem>;
export type InwardStockBody = Static<typeof InwardStockBody>;
export type TransferStockBody = Static<typeof TransferStockBody>;

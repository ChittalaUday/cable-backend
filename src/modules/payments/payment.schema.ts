import type { Static } from 'typebox';
import { Type } from 'typebox';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/config/constants';
import { COLLECTION_OUTCOMES, PAYMENT_METHODS } from '@/constants/billing';
import {
  CUSTOMER_EQUIPMENT_STATUSES,
  EQUIPMENT_OWNERSHIPS,
  EQUIPMENT_RETURN_CONDITIONS,
} from '@/constants/inventory';
import { Nullable, StringEnum, Uuid } from '@/types/typebox';

const Money = Type.String({ pattern: '^-?\\d{1,10}(\\.\\d{1,2})?$', description: 'Decimal string, e.g. "349.00"' });
const PositiveMoney = Type.String({ pattern: '^\\d{1,10}(\\.\\d{1,2})?$', description: 'Decimal string, never negative' });
const Coordinate = Type.String({ pattern: '^-?\\d{1,3}(\\.\\d{1,7})?$', description: 'Decimal degrees, e.g. "16.8697000"' });

export const RecordSubscriptionPaymentBody = Type.Object({
  customerId: Uuid,
  subscriptionId: Type.Optional(Uuid),
  amount: PositiveMoney,
  method: Type.Optional(StringEnum([...PAYMENT_METHODS])),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
  reference: Type.String({ minLength: 8, maxLength: 64 }),
  collectedAt: Type.Optional(Type.String({ format: 'date-time' })),
  latitude: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  longitude: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  gpsAccuracyM: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
});

export const RecordEquipmentPaymentBody = Type.Object({
  customerId: Uuid,
  subscriptionId: Type.Optional(Uuid),
  amount: PositiveMoney,
  method: Type.Optional(StringEnum([...PAYMENT_METHODS])),
  reference: Type.String({ minLength: 8, maxLength: 64 }),
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
  collectedAt: Type.Optional(Type.String({ format: 'date-time' })),
  latitude: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  longitude: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  gpsAccuracyM: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),

  // Mode A: Update / Replace existing equipment
  customerEquipmentId: Type.Optional(Uuid),
  replacementEquipmentId: Type.Optional(Uuid),
  replacementSerialNumber: Type.Optional(Type.String({ maxLength: 100 })),
  returnCondition: Type.Optional(StringEnum([...EQUIPMENT_RETURN_CONDITIONS])),

  // Mode B: Add another equipment (or update ownership/status)
  catalogId: Type.Optional(Uuid),
  equipmentId: Type.Optional(Uuid),
  serialNumber: Type.Optional(Type.String({ maxLength: 100 })),
  ownershipType: Type.Optional(StringEnum([...EQUIPMENT_OWNERSHIPS])),
  status: Type.Optional(StringEnum([...CUSTOMER_EQUIPMENT_STATUSES])),
});

export const ReverseCollectionBody = Type.Object({
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  reference: Type.String({ minLength: 8, maxLength: 64 }),
});

export const EquipmentDetails = Type.Object({
  itemName: Type.String(),
  itemCode: Nullable(Type.String()),
  serialNumber: Nullable(Type.String()),
  brand: Nullable(Type.String()),
  model: Nullable(Type.String()),
});

export const CollectionResponse = Type.Object({
  id: Uuid,
  customerId: Uuid,
  customerName: Nullable(Type.String()),
  customerCode: Nullable(Type.String()),
  subscriptionId: Nullable(Uuid),
  customerEquipmentId: Nullable(Uuid),
  equipment: Nullable(EquipmentDetails),
  serviceAccountNumber: Nullable(Type.String()),
  locationId: Nullable(Uuid),
  locationPath: Nullable(Type.String()),
  collectedBy: Uuid,
  collectorName: Nullable(Type.String()),
  outcome: StringEnum([...COLLECTION_OUTCOMES]),
  method: Nullable(StringEnum([...PAYMENT_METHODS])),
  dueAmount: Money,
  duesPaid: Money,
  accessoryAmount: Money,
  totalCollected: Money,
  balanceAfter: Money,
  accessories: Type.Array(Type.Object({
    catalogId: Uuid,
    name: Type.String(),
    quantity: Type.Integer(),
    unitPrice: Money,
    amount: Money,
  })),
  reversesId: Nullable(Uuid),
  reversedById: Nullable(Uuid),
  reason: Nullable(Type.String()),
  notes: Nullable(Type.String()),
  reference: Type.String(),
  collectedAt: Type.String({ format: 'date-time' }),
  latitude: Nullable(Coordinate),
  longitude: Nullable(Coordinate),
  gpsAccuracyM: Nullable(Money),
});

export const ListCollectionsQuery = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  cursor: Type.Optional(Type.String()),
  customerId: Type.Optional(Uuid),
  locationId: Type.Optional(Uuid),
  collectedBy: Type.Optional(Type.Union([Uuid, Type.Literal('me')])),
  outcome: Type.Optional(StringEnum([...COLLECTION_OUTCOMES])),
  from: Type.Optional(Type.String({ format: 'date-time' })),
  to: Type.Optional(Type.String({ format: 'date-time' })),
  nearLatitude: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  nearLongitude: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  withinM: Type.Optional(Type.Number({ minimum: 1, maximum: 100000, default: 200 })),
});

export const CollectionPage = Type.Object({
  items: Type.Array(CollectionResponse),
  total: Nullable(Type.Integer()),
  limit: Type.Integer(),
  nextCursor: Nullable(Type.String()),
  totals: Type.Object({
    duesPaid: Money,
    accessoryAmount: Money,
    totalCollected: Money,
    receipts: Type.Integer(),
  }),
});

export const CollectionIdParams = Type.Object({ id: Uuid });

export type RecordSubscriptionPaymentBody = Static<typeof RecordSubscriptionPaymentBody>;
export type RecordEquipmentPaymentBody = Static<typeof RecordEquipmentPaymentBody>;
export type ReverseCollectionBody = Static<typeof ReverseCollectionBody>;
export type EquipmentDetails = Static<typeof EquipmentDetails>;
export type CollectionResponse = Static<typeof CollectionResponse>;
export type ListCollectionsQuery = Static<typeof ListCollectionsQuery>;
export type CollectionPage = Static<typeof CollectionPage>;

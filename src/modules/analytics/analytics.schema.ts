import type { Static } from 'typebox';
import { Type } from 'typebox';
import { ACTIVITY_KINDS } from '@/constants/analytics';
import { CUSTOMER_STATUSES } from '@/constants/crm';
import { StringEnum } from '@/types/typebox';

const Money = Type.String({ pattern: '^\\d+\\.\\d{2}$' });
const NullableNumber = Type.Union([Type.Number(), Type.Null()]);
const Bar = Type.Object({ key: Type.String(), label: Type.String(), value: Money });
const Slice = Type.Object({ id: Type.String(), label: Type.String(), count: Type.Integer(), share: Type.Number() });
const CollectionMetrics = Type.Object({
  today: Money,
  week: Money,
  month: Money,
  todayReceipts: Type.Integer(),
  weekReceipts: Type.Integer(),
  monthReceipts: Type.Integer(),
});

export const AdminDashboardResponse = Type.Object({
  customers: Type.Object({
    total: Type.Integer(),
    active: Type.Integer(),
    inactive: Type.Integer(),
    pending: Type.Integer(),
    delta: NullableNumber,
    series: Type.Array(Type.Integer()),
  }),
  connections: Type.Object({
    total: Type.Integer(),
    active: Type.Integer(),
    inactive: Type.Integer(),
    suspended: Type.Integer(),
    cancelled: Type.Integer(),
    delta: NullableNumber,
    series: Type.Array(Type.Integer()),
  }),
  collections: Type.Intersect([CollectionMetrics, Type.Object({
    delta: NullableNumber,
    series: Type.Object({ daily: Type.Array(Bar), weekly: Type.Array(Bar), monthly: Type.Array(Bar) }),
  })]),
  outstanding: Type.Object({ amount: Money, accounts: Type.Integer() }),
  services: Type.Array(Slice),
  areas: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), count: Type.Integer(), share: Type.Number() })),
  recentCustomers: Type.Array(Type.Object({
    id: Type.String({ format: 'uuid' }),
    name: Type.String(),
    phone: Type.String(),
    status: StringEnum(CUSTOMER_STATUSES),
    createdAt: Type.String({ format: 'date-time' }),
    connectionCount: Type.Integer(),
  })),
  activity: Type.Array(Type.Object({
    id: Type.String(),
    kind: StringEnum(ACTIVITY_KINDS),
    title: Type.String(),
    subtitle: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
  })),
  generatedAt: Type.String({ format: 'date-time' }),
});

export const StaffDashboardResponse = Type.Object({
  personal: CollectionMetrics,
  team: Type.Union([CollectionMetrics, Type.Null()]),
  workload: Type.Object({
    customers: Type.Integer(),
    dueCustomers: Type.Integer(),
    outstanding: Money,
    activeConnections: Type.Integer(),
    inactiveConnections: Type.Integer(),
  }),
  recentCollections: Type.Array(Type.Object({
    id: Type.String({ format: 'uuid' }),
    customerId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    customerName: Type.Union([Type.String(), Type.Null()]),
    accountNumber: Type.String(),
    amount: Money,
    collectedAt: Type.String({ format: 'date-time' }),
  })),
  generatedAt: Type.String({ format: 'date-time' }),
});

export type AdminDashboard = Static<typeof AdminDashboardResponse>;
export type StaffDashboard = Static<typeof StaffDashboardResponse>;
export type StaffCollectionMetrics = Static<typeof CollectionMetrics>;

import type { Static } from 'typebox';
import type { BillingCycle, CustomerStatus, PackageType, SubscriptionStatus } from '@/shared/constants/crm';
import { Type } from 'typebox';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/config/constants';
import { BILLING_CYCLES, CUSTOMER_LOCATION_SOURCES, CUSTOMER_STATUSES, PACKAGE_TYPES, SUBSCRIPTION_STATUSES } from '@/shared/constants/crm';
import { StringEnum } from '@/shared/types/typebox';

const Uuid = Type.String({ format: 'uuid' });
const Nullable = <T extends ReturnType<typeof Type.String>>(inner: T) => Type.Union([inner, Type.Null()]);
const Money = Type.String({ description: 'Decimal string, e.g. "349.00"' });

const SubscriptionStatusSchema = Type.Unsafe<SubscriptionStatus>({ type: 'string', enum: [...SUBSCRIPTION_STATUSES] });
const BillingCycleSchema = Type.Unsafe<BillingCycle>({ type: 'string', enum: [...BILLING_CYCLES] });
const Icon = Type.Union([Type.String({ maxLength: 40 }), Type.Null()]);
const PackageTypeSchema = Type.Unsafe<PackageType>({ type: 'string', enum: [...PACKAGE_TYPES] });
const CustomerStatusSchema = Type.Unsafe<CustomerStatus>({ type: 'string', enum: [...CUSTOMER_STATUSES] });

export const SubscriptionResponse = Type.Object({
  id: Uuid,
  serviceAccountNumber: Type.String(),
  status: SubscriptionStatusSchema,
  startDate: Type.String({ format: 'date-time' }),
  endDate: Nullable(Type.String({ format: 'date-time' })),
  billingCycle: BillingCycleSchema,
  price: Money,
  locationId: Uuid,
  installationAddress: Nullable(Type.String()),
  service: Type.Object({
    id: Uuid,
    name: Type.String(),
    slug: Type.String(),
    icon: Icon,
  }),
  provider: Type.Object({ id: Uuid, name: Type.String(), slug: Type.String() }),
  package: Type.Object({
    id: Uuid,
    name: Type.String(),
    slug: Type.String(),
    packageType: PackageTypeSchema,
  }),
});

export const CustomerProfileResponse = Type.Object({
  id: Uuid,
  customerCode: Nullable(Type.String()),
  status: CustomerStatusSchema,
  outstandingBalance: Money,
  alternatePhone: Nullable(Type.String()),
  whatsappNumber: Nullable(Type.String()),
  locationId: Nullable(Uuid),
  address: Nullable(Type.String()),
  subscriptions: Type.Array(SubscriptionResponse),
  summary: Type.Object({
    subscriptions: Type.Integer(),
    activeSubscriptions: Type.Integer(),
    services: Type.Array(Type.String()),
    outstandingBalance: Money,
  }),
});

export type CustomerProfile = Static<typeof CustomerProfileResponse>;

export const ListCustomersQuery = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  cursor: Type.Optional(Type.String({ maxLength: 200 })),
  q: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 120,
    description: 'Customer, account, address, location or equipment value',
  })),
  status: Type.Optional(CustomerStatusSchema),
  locationId: Type.Optional(Uuid),
  serviceProviderId: Type.Optional(Uuid),
  packageId: Type.Optional(Uuid),
  createdFrom: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 50,
    description: 'Filter customers created on or after this timestamp (ISO-8601 string)',
  })),
  createdTo: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 50,
    description: 'Filter customers created on or before this timestamp (ISO-8601 string)',
  })),
  multiBox: Type.Optional(Type.Boolean({
    description: 'Filter customers with 2 or more subscriptions or boxes of the same service',
  })),
});

export type ListCustomersQuery = Static<typeof ListCustomersQuery>;

export const IdParams = Type.Object({ id: Uuid });

const SearchLocationResponse = Type.Object({
  locationId: Uuid,
  path: Type.String(),
  codes: Type.Array(Type.String()),
  source: StringEnum(CUSTOMER_LOCATION_SOURCES),
});

const SearchServiceAccountResponse = Type.Object({
  subscriptionId: Uuid,
  accountNumber: Type.String(),
  installationAddress: Nullable(Type.String()),
  locationId: Uuid,
  locationPath: Nullable(Type.String()),
  service: Type.Optional(Type.String()),
});

const SearchEquipmentResponse = Type.Object({
  id: Uuid,
  subscriptionId: Uuid,
  type: Type.String(),
  brand: Nullable(Type.String()),
  model: Nullable(Type.String()),
  serialNumber: Nullable(Type.String()),
  vcNumber: Nullable(Type.String()),
  macAddress: Nullable(Type.String()),
  barcode: Nullable(Type.String()),
  status: Type.String(),
});

export const CustomerListItemResponse = Type.Object({
  id: Uuid,
  customerCode: Nullable(Type.String()),
  name: Nullable(Type.String()),
  phone: Nullable(Type.String()),
  status: CustomerStatusSchema,
  outstandingBalance: Money,
  locationId: Nullable(Uuid),
  locationPath: Nullable(Type.String()),
  subscriptions: Type.Integer(),
  activeSubscriptions: Type.Integer(),
  services: Type.Array(Type.String()),
  createdAt: Type.String({ format: 'date-time' }),
  alternatePhone: Nullable(Type.String()),
  whatsappNumber: Nullable(Type.String()),
  address: Nullable(Type.String()),
  locations: Type.Array(SearchLocationResponse),
  serviceAccounts: Type.Array(SearchServiceAccountResponse),
  equipment: Type.Array(SearchEquipmentResponse),
  matchedFields: Type.Optional(Type.Array(Type.String())),
  score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

const EquipmentResponse = Type.Object({
  id: Uuid,
  subscriptionId: Uuid,
  name: Type.String(),
  serialNumber: Nullable(Type.String()),
  status: Type.String(),
  assignedAt: Type.String({ format: 'date-time' }),
  returnedAt: Nullable(Type.String({ format: 'date-time' })),
});

const TransactionResponse = Type.Object({
  id: Uuid,
  transactionNo: Type.String(),
  transactionDate: Type.String({ format: 'date-time' }),
  transactionType: Type.String(),
  serviceAccountNumber: Type.String(),
  debit: Money,
  credit: Money,
  closingBalance: Money,
  remarks: Nullable(Type.String()),
});

export const CustomerDetailResponse = Type.Object({
  id: Uuid,
  customerCode: Nullable(Type.String()),
  name: Nullable(Type.String()),
  phone: Nullable(Type.String()),
  alternatePhone: Nullable(Type.String()),
  whatsappNumber: Nullable(Type.String()),
  status: CustomerStatusSchema,
  outstandingBalance: Money,
  userId: Nullable(Uuid),
  locationId: Nullable(Uuid),
  locationPath: Nullable(Type.String()),
  address: Nullable(Type.String()),
  notes: Nullable(Type.String()),
  subscriptions: Type.Array(SubscriptionResponse),
  equipment: Type.Array(EquipmentResponse),
  recentTransactions: Type.Array(TransactionResponse),
  summary: Type.Object({
    subscriptions: Type.Integer(),
    activeSubscriptions: Type.Integer(),
    services: Type.Array(Type.String()),
    monthlyValue: Money,
    outstandingBalance: Money,
  }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const CustomerPageResponse = Type.Object({
  items: Type.Array(CustomerListItemResponse),
  total: Type.Union([Type.Integer(), Type.Null()]),
  limit: Type.Integer(),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export type CustomerPage = Static<typeof CustomerPageResponse>;
export type CustomerListItem = Static<typeof CustomerListItemResponse>;
export type CustomerDetail = Static<typeof CustomerDetailResponse>;

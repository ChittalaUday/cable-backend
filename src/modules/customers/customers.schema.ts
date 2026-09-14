import type { Static } from 'typebox';
import type { BillingCycle, CustomerStatus, PackageType, SubscriptionStatus } from '@/shared/constants/crm';
import { Type } from 'typebox';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/config/constants';
import { BILLING_CYCLES, CUSTOMER_STATUSES, PACKAGE_TYPES, SUBSCRIPTION_STATUSES } from '@/shared/constants/crm';

/**
 * The subscriber view of a signed-in account (AGENTS.md §7).
 *
 * Flattened on purpose: this is what a customer's home screen renders, so the
 * client should not have to join a package to a provider to a service itself.
 */

const Uuid = Type.String({ format: 'uuid' });
const Nullable = <T extends ReturnType<typeof Type.String>>(inner: T) => Type.Union([inner, Type.Null()]);
const Money = Type.String({ description: 'Decimal string, e.g. "349.00"' });

// `Type.Unsafe` rather than a union of literals: the lists live in
// `shared/constants/crm.ts`, so the column and the wire contract read the same
// array and adding a value is one edit (same reason as packages.schema.ts).
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
  /** The one-glance version, so a home screen needs nothing but this. */
  summary: Type.Object({
    subscriptions: Type.Integer(),
    activeSubscriptions: Type.Integer(),
    services: Type.Array(Type.String()),
    outstandingBalance: Money,
  }),
});

export type CustomerProfile = Static<typeof CustomerProfileResponse>;

/* ── Staff-facing: the list, and the one call a details page makes ────────── */

export const ListCustomersQuery = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  /**
   * `nextCursor` from the previous page. Keyset, not an offset: at 300k rows
   * `OFFSET 200000` makes Postgres walk 200,050 index entries (89ms measured),
   * where resuming from the last row read is 0.03ms and does not degrade with
   * depth. It is also correct under writes — an offset skips or repeats rows
   * when something is inserted while the operator is scrolling.
   */
  cursor: Type.Optional(Type.String({ maxLength: 200 })),
  q: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 120,
    description: 'Customer, account, address, location or equipment value',
  })),
  status: Type.Optional(CustomerStatusSchema),
  /** The subtree to look in — the node itself and everything under it. */
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
  source: Type.Union([Type.Literal('customer'), Type.Literal('subscription')]),
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

/**
 * One row of the staff customer list.
 *
 * It carries the answers a row actually shows — who, where, what they are on,
 * what they owe, plus every searchable account, location and equipment value —
 * already resolved, so rendering a page never needs per-row follow-up requests.
 */
export const CustomerListItemResponse = Type.Object({
  id: Uuid,
  customerCode: Nullable(Type.String()),
  name: Nullable(Type.String()),
  phone: Nullable(Type.String()),
  status: CustomerStatusSchema,
  outstandingBalance: Money,
  /** The breadcrumb, resolved — `Mandapeta / Sri Sai Apartments / 201`. */
  locationId: Nullable(Uuid),
  locationPath: Nullable(Type.String()),
  subscriptions: Type.Integer(),
  activeSubscriptions: Type.Integer(),
  /** Distinct service names on the active lines, for the "Cable TV, Broadband" line. */
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

/**
 * Everything a customer details page draws, in ONE response.
 *
 * A customer id fans out to subscriptions, and each of those to a provider, a
 * package and a location — so the obvious client does six round trips and an
 * N+1 over the list. This resolves the whole graph server-side, where the joins
 * are indexed and free, and hands back a shape that needs no further lookups.
 */
export const CustomerDetailResponse = Type.Object({
  id: Uuid,
  customerCode: Nullable(Type.String()),
  name: Nullable(Type.String()),
  phone: Nullable(Type.String()),
  alternatePhone: Nullable(Type.String()),
  whatsappNumber: Nullable(Type.String()),
  status: CustomerStatusSchema,
  outstandingBalance: Money,
  /** Set when the subscriber has a login; most do not. */
  userId: Nullable(Uuid),
  locationId: Nullable(Uuid),
  locationPath: Nullable(Type.String()),
  /** Free text off the import or an agent — a hint, never the structured address. */
  address: Nullable(Type.String()),
  notes: Nullable(Type.String()),
  subscriptions: Type.Array(SubscriptionResponse),
  equipment: Type.Array(EquipmentResponse),
  /** The latest ledger lines, newest first — enough for the page, not the whole history. */
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

/**
 * A page of the customer list.
 *
 * `total` only on the FIRST page: it costs a second aggregate over every
 * matching row, and it cannot change usefully while one operator scrolls. Later
 * pages send `null` rather than paying for it again.
 */
export const CustomerPageResponse = Type.Object({
  items: Type.Array(CustomerListItemResponse),
  total: Type.Union([Type.Integer(), Type.Null()]),
  limit: Type.Integer(),
  /** Pass back as `?cursor=`. `null` means this was the last page. */
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export type CustomerPage = Static<typeof CustomerPageResponse>;
export type CustomerListItem = Static<typeof CustomerListItemResponse>;
export type CustomerDetail = Static<typeof CustomerDetailResponse>;

import type { Static } from 'typebox';
import type { BillingCycle, CustomerStatus, PackageType, SubscriptionStatus } from '@/shared/constants/crm';
import { Type } from 'typebox';
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

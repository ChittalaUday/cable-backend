import type { Static } from 'typebox';
import type { BillingCycle, PackageType } from '@/shared/constants/crm';
import { Type } from 'typebox';
import { BILLING_CYCLES, PACKAGE_TYPES } from '@/shared/constants/crm';
import { PaginationQuerySchema } from '@/shared/pagination';

/**
 * Wire contracts for packages (AGENTS.md §7).
 *
 * A package belongs to a **provider**, never to a service: a price, an MSO
 * share and a billing cycle are what a supplier sets
 * (docs/services-providers-packages.md §3).
 */

const Uuid = Type.String({ format: 'uuid' });
const Name = Type.String({ minLength: 1, maxLength: 120 });
const Slug = Type.String({ minLength: 1, maxLength: 60, pattern: '^[a-z0-9]+(?:[-_][a-z0-9]+)*$' });
const Json = Type.Record(Type.String(), Type.Unknown());
const Status = Type.Union([Type.Literal('active'), Type.Literal('inactive')]);

/**
 * Money crosses the wire as a STRING (§8).
 *
 * `numeric` in Postgres, `Decimal` in the service, and never a JavaScript
 * number in between — `0.1 + 0.2` is not `0.3`, and a rupee lost per invoice is
 * a reconciliation bug nobody finds for a year.
 */
const Money = Type.String({ pattern: '^-?[0-9]{1,10}(\\.[0-9]{1,2})?$', description: 'Decimal string, e.g. "349.00"' });
const Rate = Type.String({ pattern: '^[0-9]{1,3}(\\.[0-9]{1,2})?$', description: 'Percentage as a decimal string, e.g. "18.00"' });

const PackageTypeSchema = Type.Unsafe<PackageType>({ type: 'string', enum: [...PACKAGE_TYPES] });
const BillingCycleSchema = Type.Unsafe<BillingCycle>({ type: 'string', enum: [...BILLING_CYCLES] });

export const IdParams = Type.Object({ id: Uuid });

export const PackageResponse = Type.Object({
  id: Uuid,
  serviceProviderId: Uuid,
  serviceProviderName: Type.String(),
  serviceId: Uuid,
  serviceName: Type.String(),
  name: Name,
  slug: Slug,
  packageType: PackageTypeSchema,
  price: Money,
  discount: Money,
  msoShare: Money,
  taxRate: Rate,
  billingCycle: BillingCycleSchema,
  description: Type.Union([Type.String(), Type.Null()]),
  metadata: Type.Union([Json, Type.Null()]),
  status: Status,
  /** How many channels the bouquet carries. The list itself is on `GET /packages/:id`. */
  channelCount: Type.Integer(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const PackageChannelResponse = Type.Object({
  id: Uuid,
  channelNumber: Type.Integer(),
  name: Type.String(),
  slug: Type.String(),
  genre: Type.String(),
  resolution: Type.String(),
  isFta: Type.Boolean(),
  isMandatory: Type.Boolean(),
});

export const PackageDetailResponse = Type.Intersect([
  PackageResponse,
  Type.Object({ channels: Type.Array(PackageChannelResponse) }),
]);

export const ListPackagesQuery = Type.Intersect([
  PaginationQuerySchema,
  Type.Object({
    serviceProviderId: Type.Optional(Uuid),
    /** Convenience filter: every package of every provider of this service. */
    serviceId: Type.Optional(Uuid),
    packageType: Type.Optional(PackageTypeSchema),
    status: Type.Optional(Status),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  }),
]);

export const CreatePackageBody = Type.Object({
  serviceProviderId: Uuid,
  name: Name,
  slug: Slug,
  packageType: Type.Optional(PackageTypeSchema),
  price: Type.Optional(Money),
  discount: Type.Optional(Money),
  msoShare: Type.Optional(Money),
  taxRate: Type.Optional(Rate),
  billingCycle: Type.Optional(BillingCycleSchema),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  metadata: Type.Optional(Type.Union([Json, Type.Null()])),
});

/** `serviceProviderId` is absent on purpose — see the service for why. */
export const UpdatePackageBody = Type.Partial(Type.Object({
  name: Name,
  packageType: PackageTypeSchema,
  price: Money,
  discount: Money,
  msoShare: Money,
  taxRate: Rate,
  billingCycle: BillingCycleSchema,
  description: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  metadata: Type.Union([Json, Type.Null()]),
  status: Status,
}), { minProperties: 1 });

export const SetPackageChannelsBody = Type.Object({
  /** Replaces the whole lineup. An empty array clears it. */
  channels: Type.Array(Type.Object({
    channelId: Uuid,
    isMandatory: Type.Optional(Type.Boolean()),
  }), { maxItems: 1000 }),
});

export const ListChannelsQuery = Type.Intersect([
  PaginationQuerySchema,
  Type.Object({
    serviceProviderId: Type.Optional(Uuid),
    genre: Type.Optional(Type.String({ maxLength: 40 })),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  }),
]);

export const ChannelResponse = Type.Object({
  id: Uuid,
  serviceProviderId: Uuid,
  channelNumber: Type.Integer(),
  name: Type.String(),
  slug: Type.String(),
  genre: Type.String(),
  languages: Type.Array(Type.String()),
  resolution: Type.String(),
  isFta: Type.Boolean(),
  broadcaster: Type.Union([Type.String(), Type.Null()]),
  price: Money,
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  status: Status,
});

export type IdParams = Static<typeof IdParams>;
export type PackageResponse = Static<typeof PackageResponse>;
export type PackageDetailResponse = Static<typeof PackageDetailResponse>;
export type ListPackagesQuery = Static<typeof ListPackagesQuery>;
export type CreatePackageBody = Static<typeof CreatePackageBody>;
export type UpdatePackageBody = Static<typeof UpdatePackageBody>;
export type SetPackageChannelsBody = Static<typeof SetPackageChannelsBody>;
export type ListChannelsQuery = Static<typeof ListChannelsQuery>;
export type ChannelResponse = Static<typeof ChannelResponse>;

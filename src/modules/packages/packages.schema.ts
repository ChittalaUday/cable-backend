import type { Static } from 'typebox';
import type { BillingCycle, ChannelResolution, PackageType } from '@/shared/constants/crm';
import { Type } from 'typebox';
import { BILLING_CYCLES, CHANNEL_RESOLUTIONS, ENTITY_STATUSES, PACKAGE_TYPES } from '@/shared/constants/crm';
import { PaginationQuerySchema } from '@/shared/pagination';
import { StringEnum } from '@/shared/types/typebox';

const Uuid = Type.String({ format: 'uuid' });
const Name = Type.String({ minLength: 1, maxLength: 120 });
const Slug = Type.String({ minLength: 1, maxLength: 60, pattern: '^[a-z0-9]+(?:[-_][a-z0-9]+)*$' });
const Json = Type.Record(Type.String(), Type.Unknown());
const Status = StringEnum(ENTITY_STATUSES);

const Money = Type.String({ pattern: '^-?[0-9]{1,10}(\\.[0-9]{1,2})?$', description: 'Decimal string, e.g. "349.00"' });
const Rate = Type.String({ pattern: '^[0-9]{1,3}(\\.[0-9]{1,2})?$', description: 'Percentage as a decimal string, e.g. "18.00"' });

const PackageTypeSchema = Type.Unsafe<PackageType>({ type: 'string', enum: [...PACKAGE_TYPES] });
const BillingCycleSchema = Type.Unsafe<BillingCycle>({ type: 'string', enum: [...BILLING_CYCLES] });
const ResolutionSchema = Type.Unsafe<ChannelResolution>({ type: 'string', enum: [...CHANNEL_RESOLUTIONS] });

export const IdParams = Type.Object({ id: Uuid });

export const PackageResponse = Type.Object({
  id: Uuid,
  serviceProviderId: Uuid,
  serviceProviderName: Type.String(),
  serviceId: Uuid,
  serviceName: Type.String(),
  serviceIcon: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
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
  channelCount: Type.Integer(),
  coverageAreas: Type.Array(Type.String()),
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
    serviceId: Type.Optional(Uuid),
    packageType: Type.Optional(PackageTypeSchema),
    status: Type.Optional(Status),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  }),
]);

export const CreatePackageBody = Type.Object({
  serviceProviderId: Uuid,
  name: Name,
  slug: Type.Optional(Slug),
  packageType: Type.Optional(PackageTypeSchema),
  price: Type.Optional(Money),
  discount: Type.Optional(Money),
  msoShare: Type.Optional(Money),
  taxRate: Type.Optional(Rate),
  billingCycle: Type.Optional(BillingCycleSchema),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  metadata: Type.Optional(Type.Union([Json, Type.Null()])),
});

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
    resolution: Type.Optional(ResolutionSchema),
    packageId: Type.Optional(Uuid),
    inPackage: Type.Optional(Type.Boolean()),
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

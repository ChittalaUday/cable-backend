import type { Static } from 'typebox';
import { Type } from 'typebox';
import { ENTITY_STATUSES } from '@/shared/constants/crm';
import { StringEnum } from '@/shared/types/typebox';

const Uuid = Type.String({ format: 'uuid' });
const Name = Type.String({ minLength: 1, maxLength: 120 });
const Slug = Type.String({ minLength: 1, maxLength: 60, pattern: '^[a-z0-9]+(?:[-_][a-z0-9]+)*$' });
const Json = Type.Record(Type.String(), Type.Unknown());
const Status = StringEnum(ENTITY_STATUSES);

const Icon = Type.String({ minLength: 1, maxLength: 40, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' });

export const IdParams = Type.Object({ id: Uuid });

export const ProviderResponse = Type.Object({
  id: Uuid,
  serviceId: Uuid,
  serviceName: Type.String(),
  serviceIcon: Type.Union([Icon, Type.Null()]),
  packageCount: Type.Integer(),
  name: Name,
  slug: Slug,
  code: Type.Union([Type.String(), Type.Null()]),
  description: Type.Union([Type.String(), Type.Null()]),
  contact: Type.Union([Json, Type.Null()]),
  metadata: Type.Union([Json, Type.Null()]),
  status: Status,
  isDefault: Type.Boolean(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const ServiceResponse = Type.Object({
  id: Uuid,
  name: Name,
  slug: Slug,
  icon: Type.Union([Icon, Type.Null()]),
  description: Type.Union([Type.String(), Type.Null()]),
  status: Status,
  metadata: Type.Union([Json, Type.Null()]),
  providerCount: Type.Integer(),
  providers: Type.Array(ProviderResponse),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const CreateServiceBody = Type.Object({
  name: Name,
  slug: Type.Optional(Slug),
  icon: Type.Optional(Type.Union([Icon, Type.Null()])),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  metadata: Type.Optional(Type.Union([Json, Type.Null()])),
});

export const UpdateServiceBody = Type.Partial(Type.Object({
  name: Name,
  icon: Type.Union([Icon, Type.Null()]),
  description: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  status: Status,
  metadata: Type.Union([Json, Type.Null()]),
}), { minProperties: 1 });

export const ListServicesQuery = Type.Object({
  status: Type.Optional(Status),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
});

export const CreateProviderBody = Type.Object({
  serviceId: Uuid,
  name: Name,
  slug: Type.Optional(Slug),
  code: Type.Optional(Type.String({ maxLength: 60 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  contact: Type.Optional(Type.Union([Json, Type.Null()])),
  metadata: Type.Optional(Type.Union([Json, Type.Null()])),
  isDefault: Type.Optional(Type.Boolean()),
});

export const UpdateProviderBody = Type.Partial(Type.Object({
  name: Name,
  code: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
  description: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  contact: Type.Union([Json, Type.Null()]),
  metadata: Type.Union([Json, Type.Null()]),
  status: Status,
  isDefault: Type.Boolean(),
}), { minProperties: 1 });

export const ListProvidersQuery = Type.Object({
  serviceId: Type.Optional(Uuid),
  status: Type.Optional(Status),
  search: Type.Optional(Type.String()),
});

export type IdParams = Static<typeof IdParams>;
export type ServiceResponse = Static<typeof ServiceResponse>;
export type CreateServiceBody = Static<typeof CreateServiceBody>;
export type UpdateServiceBody = Static<typeof UpdateServiceBody>;
export type ListServicesQuery = Static<typeof ListServicesQuery>;
export type ProviderResponse = Static<typeof ProviderResponse>;
export type CreateProviderBody = Static<typeof CreateProviderBody>;
export type UpdateProviderBody = Static<typeof UpdateProviderBody>;
export type ListProvidersQuery = Static<typeof ListProvidersQuery>;

export const CoverageResponse = Type.Object({
  id: Uuid,
  serviceId: Uuid,
  serviceProviderId: Type.Union([Uuid, Type.Null()]),
  packageId: Type.Union([Uuid, Type.Null()]),
  locationId: Uuid,
  locationPath: Type.String(),
  isAvailable: Type.Boolean(),
  note: Type.Union([Type.String(), Type.Null()]),
});

export const CoverageEntry = Type.Object({
  locationId: Uuid,
  isAvailable: Type.Optional(Type.Boolean()),
  note: Type.Optional(Type.String({ maxLength: 200 })),
});

export const SetCoverageBody = Type.Object({
  entries: Type.Array(CoverageEntry, { maxItems: 500 }),
});

export const AvailabilityResponse = Type.Object({
  locationId: Uuid,
  services: Type.Array(Type.Object({
    id: Uuid,
    name: Type.String(),
    slug: Type.String(),
    icon: Type.Union([Icon, Type.Null()]),
    providers: Type.Array(Type.Object({
      id: Uuid,
      name: Type.String(),
      slug: Type.String(),
      isDefault: Type.Boolean(),
      packages: Type.Array(Type.Object({
        id: Uuid,
        name: Type.String(),
        slug: Type.String(),
        packageType: Type.String(),
        price: Type.String(),
        billingCycle: Type.String(),
      })),
    })),
  })),
});

export const LocationIdParams = Type.Object({ id: Uuid });

export type CoverageResponse = Static<typeof CoverageResponse>;
export type CoverageEntry = Static<typeof CoverageEntry>;
export type SetCoverageBody = Static<typeof SetCoverageBody>;
export type AvailabilityResponse = Static<typeof AvailabilityResponse>;

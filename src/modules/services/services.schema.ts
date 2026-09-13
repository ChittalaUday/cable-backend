import type { Static } from 'typebox';
import type { ServiceType } from '@/shared/constants/crm';
import { Type } from 'typebox';
import { SERVICE_TYPES } from '@/shared/constants/crm';

/**
 * Wire contracts for the service catalogue (AGENTS.md §7).
 *
 * A **service** is what a subscriber buys (Cable TV, Broadband). A **provider**
 * is the supplier delivering it (ACT Digital, Satya Fiber). Packages and
 * channels hang off the provider — see docs/services-providers-packages.md.
 */

const Uuid = Type.String({ format: 'uuid' });
const Name = Type.String({ minLength: 1, maxLength: 120 });
const Slug = Type.String({ minLength: 1, maxLength: 60, pattern: '^[a-z0-9]+(?:[-_][a-z0-9]+)*$' });
const Json = Type.Record(Type.String(), Type.Unknown());
const Status = Type.Union([Type.Literal('active'), Type.Literal('inactive')]);

/**
 * The `service_type` enum, kept in one place.
 *
 * `Type.Unsafe` because the list lives in `shared/constants/crm.ts` — the
 * database column and the wire contract read the same array, so adding a type
 * is one edit rather than two that can disagree.
 */
const ServiceTypeSchema = Type.Unsafe<ServiceType>({ type: 'string', enum: [...SERVICE_TYPES] });

export const IdParams = Type.Object({ id: Uuid });

export const ServiceResponse = Type.Object({
  id: Uuid,
  name: Name,
  slug: Slug,
  serviceType: ServiceTypeSchema,
  description: Type.Union([Type.String(), Type.Null()]),
  status: Status,
  metadata: Type.Union([Json, Type.Null()]),
  /** How many active providers deliver it — the tenant's answer to "can I sell this?" */
  providerCount: Type.Integer(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const CreateServiceBody = Type.Object({
  name: Name,
  slug: Slug,
  serviceType: ServiceTypeSchema,
  description: Type.Optional(Type.String({ maxLength: 500 })),
  metadata: Type.Optional(Type.Union([Json, Type.Null()])),
});

export const UpdateServiceBody = Type.Partial(Type.Object({
  name: Name,
  description: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  status: Status,
  metadata: Type.Union([Json, Type.Null()]),
}), { minProperties: 1 });

export const ListServicesQuery = Type.Object({
  status: Type.Optional(Status),
  serviceType: Type.Optional(ServiceTypeSchema),
});

// ─── Providers ────────────────────────────────────────────────────────────────

export const ProviderResponse = Type.Object({
  id: Uuid,
  serviceId: Uuid,
  serviceName: Type.String(),
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

export const CreateProviderBody = Type.Object({
  serviceId: Uuid,
  name: Name,
  slug: Slug,
  code: Type.Optional(Type.String({ maxLength: 60 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  contact: Type.Optional(Type.Union([Json, Type.Null()])),
  metadata: Type.Optional(Type.Union([Json, Type.Null()])),
  /** Makes this the provider a wizard preselects; the previous default is cleared. */
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

// ─── Coverage and availability ────────────────────────────────────────────────

export const CoverageResponse = Type.Object({
  id: Uuid,
  serviceId: Uuid,
  serviceProviderId: Type.Union([Uuid, Type.Null()]),
  locationId: Uuid,
  /** `Mandapeta / Sri Sai Apartments` — the breadcrumb, so a list reads. */
  locationPath: Type.String(),
  isAvailable: Type.Boolean(),
  note: Type.Union([Type.String(), Type.Null()]),
});

export const CoverageEntry = Type.Object({
  locationId: Uuid,
  /** `false` punches a hole in a wider area that IS covered. */
  isAvailable: Type.Optional(Type.Boolean()),
  note: Type.Optional(Type.String({ maxLength: 200 })),
});

export const SetCoverageBody = Type.Object({
  /** Replaces the whole set. `[]` means "no coverage rows", which means everywhere. */
  entries: Type.Array(CoverageEntry, { maxItems: 500 }),
});

export const AvailabilityResponse = Type.Object({
  locationId: Uuid,
  services: Type.Array(Type.Object({
    id: Uuid,
    name: Type.String(),
    slug: Type.String(),
    serviceType: Type.String(),
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

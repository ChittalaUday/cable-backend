import type { Static } from 'typebox';
import { Type } from 'typebox';

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
 * The icon a tenant picked for a service, as a name the app resolves.
 *
 * A tenant defines its own services — "Cable TV", "Internet + IPTV" — so there
 * is no fixed set of types to colour them by; the icon is the thing that tells
 * them apart in a list.
 */
const Icon = Type.String({ minLength: 1, maxLength: 40, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' });

export const IdParams = Type.Object({ id: Uuid });

export const ProviderResponse = Type.Object({
  id: Uuid,
  serviceId: Uuid,
  serviceName: Type.String(),
  /** The icon of the service it supplies, so a provider list reads the same. */
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
  /** Derived from `name` when absent — the app's forms only collect a name. */
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

// ─── Providers ────────────────────────────────────────────────────────────────

export const CreateProviderBody = Type.Object({
  serviceId: Uuid,
  name: Name,
  /** Derived from `name` when absent — the app's forms only collect a name. */
  slug: Type.Optional(Slug),
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

// ─── Coverage and availability ────────────────────────────────────────────────

export const CoverageResponse = Type.Object({
  id: Uuid,
  serviceId: Uuid,
  serviceProviderId: Type.Union([Uuid, Type.Null()]),
  /** Set on the narrowest kind of row: this one package, here. */
  packageId: Type.Union([Uuid, Type.Null()]),
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

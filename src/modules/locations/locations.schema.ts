import type { Static } from 'typebox';
import { Type } from 'typebox';
import { LOCATION_SOURCES, LOCATION_STATUSES, LOCATION_WRITABLE_STATUSES } from '@/shared/constants/geo';
import { PaginationQuerySchema } from '@/shared/pagination';
import { StringEnum } from '@/shared/types/typebox';

const Uuid = Type.String({ format: 'uuid' });
const Name = Type.String({ minLength: 1, maxLength: 120 });
const Slug = Type.String({ minLength: 1, maxLength: 60, pattern: '^[a-z0-9]+(?:[-_][a-z0-9]+)*$' });
const Config = Type.Record(Type.String(), Type.Unknown());

export const IdParams = Type.Object({ id: Uuid });

export const CategoryResponse = Type.Object({
  id: Uuid,
  name: Name,
  slug: Slug,
  config: Config,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const CreateCategoryBody = Type.Object({
  name: Name,
  slug: Slug,
  config: Type.Optional(Config),
});

export const UpdateCategoryBody = Type.Partial(Type.Object({
  name: Name,
  config: Config,
}), { minProperties: 1 });

export const SchemaLevelResponse = Type.Object({
  id: Uuid,
  categoryId: Uuid,
  categorySlug: Type.String(),
  categoryName: Type.String(),
  depth: Type.Integer(),
  isTerminal: Type.Boolean(),
  config: Config,
});

export const SchemaResponse = Type.Object({
  id: Uuid,
  name: Name,
  slug: Slug,
  description: Type.Union([Type.String(), Type.Null()]),
  isActive: Type.Boolean(),
  levels: Type.Array(SchemaLevelResponse),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const CreateSchemaBody = Type.Object({
  name: Name,
  slug: Slug,
  description: Type.Optional(Type.String({ maxLength: 500 })),
  levels: Type.Array(Type.Object({
    categoryId: Uuid,
    isTerminal: Type.Optional(Type.Boolean()),
    config: Type.Optional(Config),
  }), { minItems: 1, maxItems: 12 }),
});

export const UpdateSchemaBody = Type.Partial(Type.Object({
  name: Name,
  description: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  isActive: Type.Boolean(),
}), { minProperties: 1 });

export const GenerateLevel = Type.Object({
  names: Type.Optional(Type.Array(Name, { minItems: 1, maxItems: 200 })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  nameFormat: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  codeFormat: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  startAt: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
});

export const GenerateBody = Type.Object({
  parentId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  levels: Type.Array(GenerateLevel, { minItems: 1, maxItems: 8 }),
});

export const GenerateResponse = Type.Object({
  created: Type.Integer(),
  leafIds: Type.Array(Uuid),
});

export const LocationResponse = Type.Object({
  id: Uuid,
  schemaId: Uuid,
  categoryId: Uuid,
  parentId: Type.Union([Uuid, Type.Null()]),
  name: Name,
  code: Type.Union([Type.String(), Type.Null()]),
  source: StringEnum(LOCATION_SOURCES),
  status: StringEnum(LOCATION_STATUSES),
  isActive: Type.Boolean(),
  latitude: Type.Union([Type.String(), Type.Null()]),
  longitude: Type.Union([Type.String(), Type.Null()]),
  metadata: Type.Union([Config, Type.Null()]),
  aliases: Type.Array(Type.String()),
  depth: Type.Integer(),
  path: Type.String(),
  pathIds: Type.Array(Uuid),
  childCount: Type.Integer(),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const AncestorResponse = Type.Intersect([
  LocationResponse,
  Type.Object({
    siblingIndex: Type.Integer({ description: '0-based rank among its siblings, in list order' }),
  }),
]);

export const ListLocationsQuery = Type.Intersect([
  PaginationQuerySchema,
  Type.Object({
    parentId: Type.Optional(Type.Union([Uuid, Type.Literal('null')])),
    ancestorId: Type.Optional(Uuid),
    schemaId: Type.Optional(Uuid),
    categoryId: Type.Optional(Uuid),
    status: Type.Optional(StringEnum(LOCATION_STATUSES)),
    isActive: Type.Optional(Type.Boolean()),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    coverageServiceId: Type.Optional(Uuid),
    coverageProviderId: Type.Optional(Uuid),
  }),
]);

export const CreateLocationBody = Type.Object({
  schemaId: Type.Optional(Uuid),
  categoryId: Type.Optional(Uuid),
  parentId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  name: Name,
  code: Type.Optional(Type.String({ maxLength: 60 })),
  status: Type.Optional(StringEnum(LOCATION_WRITABLE_STATUSES)),
  latitude: Type.Optional(Type.Union([Type.Number({ minimum: -90, maximum: 90 }), Type.Null()])),
  longitude: Type.Optional(Type.Union([Type.Number({ minimum: -180, maximum: 180 }), Type.Null()])),
  metadata: Type.Optional(Type.Union([Config, Type.Null()])),
  aliases: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 20 })),
});

export const UpdateLocationBody = Type.Partial(Type.Object({
  name: Name,
  code: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
  status: StringEnum(LOCATION_STATUSES),
  isActive: Type.Boolean(),
  latitude: Type.Union([Type.Number({ minimum: -90, maximum: 90 }), Type.Null()]),
  longitude: Type.Union([Type.Number({ minimum: -180, maximum: 180 }), Type.Null()]),
  metadata: Type.Union([Config, Type.Null()]),
  aliases: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 20 }),
}), { minProperties: 1 });

export type CategoryResponse = Static<typeof CategoryResponse>;
export type CreateCategoryBody = Static<typeof CreateCategoryBody>;
export type UpdateCategoryBody = Static<typeof UpdateCategoryBody>;
export type SchemaResponse = Static<typeof SchemaResponse>;
export type CreateSchemaBody = Static<typeof CreateSchemaBody>;
export type UpdateSchemaBody = Static<typeof UpdateSchemaBody>;
export type GenerateBody = Static<typeof GenerateBody>;
export type GenerateLevel = Static<typeof GenerateLevel>;
export type LocationResponse = Static<typeof LocationResponse>;
export type AncestorResponse = Static<typeof AncestorResponse>;
export type ListLocationsQuery = Static<typeof ListLocationsQuery>;
export type CreateLocationBody = Static<typeof CreateLocationBody>;
export type UpdateLocationBody = Static<typeof UpdateLocationBody>;
export type IdParams = Static<typeof IdParams>;

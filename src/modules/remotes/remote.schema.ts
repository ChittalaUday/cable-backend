import type { Static } from 'typebox';
import { Type } from 'typebox';
import { REMOTE_SOURCES } from '@/constants/remotes';
import { DeviceType, RemoteButtonSchema } from '@/types/remotes';
import { StringEnum } from '@/types/typebox';

export const IdParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

export const ListRemotesQuery = Type.Object({
  deviceType: Type.Optional(DeviceType),
  brand: Type.Optional(Type.String()),
  search: Type.Optional(Type.String()),
});

const RemoteFields = {
  id: Type.String({ format: 'uuid' }),
  deviceType: DeviceType,
  brand: Type.String(),
  model: Type.String(),
  source: StringEnum(REMOTE_SOURCES),
  verified: Type.Boolean(),
  notes: Type.Union([Type.String(), Type.Null()]),
  isTenantOwned: Type.Boolean(),
};

export const RemoteSummary = Type.Object({
  ...RemoteFields,
  buttonCount: Type.Integer(),
});

export const RemoteDetail = Type.Object({
  ...RemoteFields,
  buttons: Type.Array(RemoteButtonSchema),
});

export const CreateRemoteBody = Type.Object({
  deviceType: DeviceType,
  brand: Type.String({ minLength: 1, maxLength: 60 }),
  model: Type.String({ minLength: 1, maxLength: 60 }),
  notes: Type.Optional(Type.String({ maxLength: 500 })),
  verified: Type.Optional(Type.Boolean()),
  buttons: Type.Array(RemoteButtonSchema, { minItems: 1, maxItems: 200 }),
});

export type ListRemotesQuery = Static<typeof ListRemotesQuery>;
export type CreateRemoteBody = Static<typeof CreateRemoteBody>;
export type RemoteSummary = Static<typeof RemoteSummary>;
export type RemoteDetail = Static<typeof RemoteDetail>;

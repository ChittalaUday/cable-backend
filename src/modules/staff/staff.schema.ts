import type { Static } from 'typebox';
import type { EntityStatus } from '@/constants/crm';
import { Type } from 'typebox';
import { STAFF_ROLES } from '@/constants/auth';
import { ENTITY_STATUSES } from '@/constants/crm';
import { MEMBERSHIP_SETTABLE_STATUSES, MEMBERSHIP_STATUSES } from '@/constants/tenancy';
import { StringEnum } from '@/types/typebox';
import { PaginationQuerySchema } from '@/utils/pagination';

const Uuid = Type.String({ format: 'uuid' });
const Nullable = <T extends ReturnType<typeof Type.String>>(inner: T) => Type.Union([inner, Type.Null()]);

const StaffRole = StringEnum(STAFF_ROLES);
const MembershipStatus = StringEnum(MEMBERSHIP_STATUSES);
const TeamStatus = Type.Unsafe<EntityStatus>({ type: 'string', enum: [...ENTITY_STATUSES] });

export const IdParams = Type.Object({ id: Uuid });

export const LocationRef = Type.Object({
  id: Uuid,
  name: Type.String(),
  path: Type.String({ description: 'Root-first breadcrumb, e.g. "Mandapeta / Sai Nagar"' }),
});

export const TeamRef = Type.Object({ id: Uuid, name: Type.String(), slug: Type.String() });

export const StaffResponse = Type.Object({
  id: Uuid,
  userId: Uuid,
  name: Nullable(Type.String()),
  email: Nullable(Type.String()),
  phone: Nullable(Type.String()),
  photoUrl: Nullable(Type.String()),
  roleId: StaffRole,
  status: MembershipStatus,
  team: Type.Union([TeamRef, Type.Null()]),
  isTeamLeader: Type.Boolean(),
  locations: Type.Array(LocationRef),
  inheritedLocations: Type.Array(LocationRef),
  teamAreas: Type.Array(LocationRef),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const ListStaffQuery = Type.Intersect([
  PaginationQuerySchema,
  Type.Object({
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: 'Matches name, email or phone' })),
    roleId: Type.Optional(StaffRole),
    status: Type.Optional(MembershipStatus),
    teamId: Type.Optional(Type.Union([Uuid, Type.Literal('null', { description: 'On no team' })])),
    locationId: Type.Optional(Uuid),
  }),
]);

export const CreateStaffBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  email: Type.Optional(Type.String({ format: 'email', maxLength: 160 })),
  phone: Type.Optional(Type.String({ pattern: '^[0-9]{10}$' })),
  password: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
  roleId: Type.Optional(StaffRole),
  status: Type.Optional(StringEnum(MEMBERSHIP_SETTABLE_STATUSES)),
  teamId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  locationIds: Type.Optional(Type.Array(Uuid, { maxItems: 200 })),
});

export const UpdateStaffBody = Type.Partial(Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  roleId: StaffRole,
  status: MembershipStatus,
  teamId: Type.Union([Uuid, Type.Null()]),
}), { minProperties: 1 });

export const SetTeamAreasBody = Type.Object({
  locationIds: Type.Array(Uuid, { maxItems: 200 }),
});

export const SetLocationsBody = Type.Object({
  locationIds: Type.Array(Uuid, { maxItems: 200 }),
});

export const TeamMemberResponse = Type.Object({
  id: Uuid,
  userId: Uuid,
  name: Nullable(Type.String()),
  phone: Nullable(Type.String()),
  email: Nullable(Type.String()),
  roleId: StaffRole,
  status: MembershipStatus,
  isTeamLeader: Type.Boolean(),
  locations: Type.Array(LocationRef),
  teamAreas: Type.Array(LocationRef),
});

export const TeamResponse = Type.Object({
  id: Uuid,
  name: Type.String(),
  slug: Type.String(),
  description: Nullable(Type.String()),
  status: TeamStatus,
  leaderMembershipId: Type.Union([Uuid, Type.Null()], { description: 'The membership leading this crew; a membership may lead at most one' }),
  memberCount: Type.Integer(),
  locations: Type.Array(LocationRef),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const ListTeamsQuery = Type.Intersect([
  PaginationQuerySchema,
  Type.Object({
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    status: Type.Optional(TeamStatus),
  }),
]);

export const CreateTeamBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  slug: Type.Optional(Type.String({ pattern: '^[a-z0-9]+(?:[-_][a-z0-9]+)*$', maxLength: 60 })),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  status: Type.Optional(TeamStatus),
  locationIds: Type.Optional(Type.Array(Uuid, { maxItems: 200 })),
});

export const UpdateTeamBody = Type.Partial(Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  status: TeamStatus,
  leaderMembershipId: Type.Union([Uuid, Type.Null()]),
}), { minProperties: 1 });

export type LocationRef = Static<typeof LocationRef>;
export type StaffResponse = Static<typeof StaffResponse>;
export type ListStaffQuery = Static<typeof ListStaffQuery>;
export type CreateStaffBody = Static<typeof CreateStaffBody>;
export type UpdateStaffBody = Static<typeof UpdateStaffBody>;
export type SetLocationsBody = Static<typeof SetLocationsBody>;
export type TeamResponse = Static<typeof TeamResponse>;
export type TeamMemberResponse = Static<typeof TeamMemberResponse>;
export type SetTeamAreasBody = Static<typeof SetTeamAreasBody>;
export type ListTeamsQuery = Static<typeof ListTeamsQuery>;
export type CreateTeamBody = Static<typeof CreateTeamBody>;
export type UpdateTeamBody = Static<typeof UpdateTeamBody>;
export type IdParams = Static<typeof IdParams>;

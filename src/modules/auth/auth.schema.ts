import type { Static } from 'typebox';
import { Type } from 'typebox';
import { CustomerProfileResponse } from '@/modules/customers/customers.service';

export const DeviceHeaders = Type.Object({
  'x-device-id': Type.String({ minLength: 8, maxLength: 128 }),
  'x-platform': Type.Union([Type.Literal('ios'), Type.Literal('android'), Type.Literal('web')]),
  'x-app-version': Type.Optional(Type.String({ maxLength: 32 })),
  'x-os-version': Type.Optional(Type.String({ maxLength: 64 })),
  'x-device-model': Type.Optional(Type.String({ maxLength: 64 })),
});

export const PhoneField = Type.String({ minLength: 6, maxLength: 20, description: 'E.164 or national; normalised server-side' });

export const RequestOtpBody = Type.Object({
  phone: PhoneField,
  channel: Type.Optional(Type.Union([Type.Literal('whatsapp'), Type.Literal('sms')])),
});

export const RequestOtpResponse = Type.Object({
  status: Type.Literal('accepted'),
  channel: Type.String(),
  expiresInSeconds: Type.Integer(),
});

export const VerifyOtpBody = Type.Object({
  phone: PhoneField,
  code: Type.String({ minLength: 4, maxLength: 8, pattern: '^[0-9]+$' }),
});

export const LoginBody = Type.Object({
  identifier: Type.String({ minLength: 3, maxLength: 254, description: 'Email or phone' }),
  password: Type.String({ minLength: 8, maxLength: 200 }),
});

export const RefreshBody = Type.Object({
  refreshToken: Type.String({ minLength: 20, maxLength: 200 }),
});

export const UserResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  name: Type.Union([Type.String(), Type.Null()]),
  photoUrl: Type.Union([Type.String(), Type.Null()]),
});

export const TokensResponse = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
  expiresIn: Type.Integer({ description: 'Access token lifetime in seconds' }),
  tokenType: Type.Literal('Bearer'),
});

const MembershipResponse = Type.Object({
  tenantId: Type.String({ format: 'uuid' }),
  tenantName: Type.String({ description: 'What a tenant picker shows — the id alone is a UUID' }),
  roleId: Type.String(),
});

/**
 * Role is per membership, never per user (§11) — a user can be `admin` of one
 * operator and `customer` of another, so sign-in answers with the list and the
 * client picks.
 *
 * It is here so a client does not have to call `/auth/me` just to find out what
 * to render. It is **not** an authorization answer: permissions are resolved
 * from the database on every protected request (§5), and this list is as stale
 * as the moment sign-in happened.
 */
export const SessionResponse = Type.Intersect([
  TokensResponse,
  Type.Object({
    user: UserResponse,
    memberships: Type.Array(MembershipResponse),
  }),
]);

export const MeResponse = Type.Object({
  user: UserResponse,
  sessionId: Type.String({ format: 'uuid' }),
  deviceId: Type.String({ format: 'uuid' }),
  memberships: Type.Array(MembershipResponse),
  /**
   * The caller's subscriber record in the **active** tenant, with its address
   * and what it is subscribed to — `null` for staff, and for a caller who
   * belongs to several tenants and did not say which.
   */
  customer: Type.Union([CustomerProfileResponse, Type.Null()]),
});

export const LogoutResponse = Type.Object({
  revokedSessions: Type.Integer(),
});

export type DeviceHeaders = Static<typeof DeviceHeaders>;
export type RequestOtpBody = Static<typeof RequestOtpBody>;
export type VerifyOtpBody = Static<typeof VerifyOtpBody>;
export type LoginBody = Static<typeof LoginBody>;
export type RefreshBody = Static<typeof RefreshBody>;
export type UserResponse = Static<typeof UserResponse>;

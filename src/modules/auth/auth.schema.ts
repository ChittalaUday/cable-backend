import type { Static } from 'typebox';
import { Type } from 'typebox';

/**
 * Wire contracts for auth (AGENTS.md §7).
 *
 * Every route declares a response schema. Fastify's serializer is what
 * guarantees `password_hash` cannot leave the process even if a service hands
 * the whole user row over.
 */

/** Device headers (§4.6). Client-supplied identity for support and revocation — never an auth factor. */
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

/** Deliberately says nothing about whether the number is registered (§4.3.1). */
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

/** The public shape of a user. `passwordHash` and `googleSub` are absent by construction. */
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

export const SessionResponse = Type.Intersect([
  TokensResponse,
  Type.Object({ user: UserResponse }),
]);

export const MeResponse = Type.Object({
  user: UserResponse,
  sessionId: Type.String({ format: 'uuid' }),
  deviceId: Type.String({ format: 'uuid' }),
  memberships: Type.Array(Type.Object({
    tenantId: Type.String({ format: 'uuid' }),
    roleId: Type.String(),
  })),
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

import type { Static } from 'typebox';
import { Type } from 'typebox';
import { CustomerProfileResponse } from '@/modules/customers/customers.service';
import { DEVICE_PLATFORMS, OTP_CHANNELS } from '@/shared/constants/auth';
import { StringEnum } from '@/shared/types/typebox';

export const DeviceHeaders = Type.Object({
  'x-device-id': Type.String({ minLength: 8, maxLength: 128 }),
  'x-platform': StringEnum(DEVICE_PLATFORMS),
  'x-app-version': Type.Optional(Type.String({ maxLength: 32 })),
  'x-os-version': Type.Optional(Type.String({ maxLength: 64 })),
  'x-device-model': Type.Optional(Type.String({ maxLength: 64 })),
});

export const PhoneField = Type.String({ minLength: 6, maxLength: 20, description: 'E.164 or national; normalised server-side' });

export const RequestOtpBody = Type.Object({
  phone: PhoneField,
  channel: Type.Optional(StringEnum(OTP_CHANNELS)),
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

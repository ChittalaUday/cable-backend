import type { Static } from 'typebox';
import { Type } from 'typebox';
import { DEVICE_PLATFORMS, OTP_CHANNELS } from '@/constants/auth';
import { MEMBERSHIP_STATUSES } from '@/constants/tenancy';
import { CustomerProfileResponse } from '@/modules/customers/customer.service';
import { PERMISSION_SCOPES } from '@/security/permissions';
import { StringEnum } from '@/types/typebox';

export const DeviceHeaders = Type.Object({
  'x-device-id': Type.String({ minLength: 8, maxLength: 128 }),
  'x-platform': StringEnum(DEVICE_PLATFORMS),
  'x-app-version': Type.Optional(Type.String({ maxLength: 32 })),
  'x-os-version': Type.Optional(Type.String({ maxLength: 64 })),
  'x-device-model': Type.Optional(Type.String({ maxLength: 64 })),
  'x-device-manufacturer': Type.Optional(Type.String({ maxLength: 64 })),
  'x-device-ram-mb': Type.Optional(Type.String({ pattern: '^[0-9]{1,7}$' })),
  'x-screen-resolution': Type.Optional(Type.String({ pattern: '^[0-9]{1,5}x[0-9]{1,5}$' })),
});

export const PhoneField = Type.String({ minLength: 6, maxLength: 20, description: 'E.164 or national; normalised server-side' });

export const ChallengeTokenField = Type.String({
  minLength: 20,
  maxLength: 2048,
  description: 'From a login that answered otp_required. Sends the code to the account\'s email.',
});

export const RequestOtpBody = Type.Union([
  Type.Object({
    phone: PhoneField,
    channel: Type.Optional(StringEnum(OTP_CHANNELS)),
  }),
  Type.Object({ challengeToken: ChallengeTokenField }),
], { description: 'A phone number, or the challenge token from a password sign-in' });

export const RequestOtpResponse = Type.Object({
  status: Type.Literal('accepted'),
  channel: Type.String(),
  expiresInSeconds: Type.Integer(),
  nextCooldownSeconds: Type.Integer({ description: 'Seconds before the next OTP can be requested' }),
});

export const OtpCodeField = Type.String({ minLength: 4, maxLength: 8, pattern: '^[0-9]+$' });

export const VerifyOtpBody = Type.Union([
  Type.Object({ phone: PhoneField, code: OtpCodeField }),
  Type.Object({ challengeToken: ChallengeTokenField, code: OtpCodeField }),
]);

export const GoogleSignInBody = Type.Object({
  idToken: Type.String({ minLength: 20, maxLength: 4096, description: 'Google ID token from the mobile sign-in' }),
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

const MembershipPermissionResponse = Type.Object({
  key: Type.String({ description: 'Permission key, e.g. customers.view' }),
  scope: StringEnum(PERMISSION_SCOPES),
});

export const MembershipResponse = Type.Object({
  membershipId: Type.String({ format: 'uuid' }),
  tenantId: Type.String({ format: 'uuid' }),
  tenantName: Type.String({ description: 'What a tenant picker shows — the id alone is a UUID' }),
  roleId: Type.String(),
  status: StringEnum(MEMBERSHIP_STATUSES),
  teamId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  permissionVersion: Type.Integer({ description: 'Incremented when role permissions change — use to bust local caches' }),
  permissions: Type.Array(MembershipPermissionResponse, { description: 'All permission grants for the user\'s role in this tenant' }),
});

export const SessionResponse = Type.Intersect([
  TokensResponse,
  Type.Object({
    user: UserResponse,
    memberships: Type.Array(MembershipResponse),
  }),
]);

/** A password was accepted but the sign-in needs the emailed code to finish. */
export const OtpChallengeResponse = Type.Object({
  status: Type.Literal('otp_required'),
  challengeToken: Type.String(),
  channel: Type.String(),
  expiresInSeconds: Type.Integer(),
  nextCooldownSeconds: Type.Integer(),
});

/**
 * Tokens, or a challenge when EMAIL_OTP_ENABLED is on. A client tells them
 * apart by `status`, which only the challenge carries.
 */
export const LoginResponse = Type.Union([SessionResponse, OtpChallengeResponse]);

/**
 * What this deployment lets a client sign in with, read before the login screen
 * is drawn. `phoneOtpChannels` is live state, not configuration: a channel whose
 * provider is failing drops out of it until it recovers.
 */
export const LoginConfigResponse = Type.Object({
  password: Type.Boolean({ description: 'Email or phone with a password' }),
  passwordNeedsEmailOtp: Type.Boolean({ description: 'A password sign-in is finished with an emailed code' }),
  phoneOtp: Type.Boolean(),
  phoneOtpChannels: Type.Array(StringEnum(OTP_CHANNELS), { description: 'Channels answering right now, best first' }),
  defaultPhoneOtpChannel: Type.Union([StringEnum(OTP_CHANNELS), Type.Null()]),
  google: Type.Boolean(),
});

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

export type MembershipResponse = Static<typeof MembershipResponse>;

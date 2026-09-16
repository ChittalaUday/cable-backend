import type { SystemRoleId } from '@/config/constants';

export const DEVICE_PLATFORMS = ['ios', 'android', 'web'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const OTP_PURPOSES = ['login', 'verify_phone'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const OTP_CHANNELS = ['whatsapp', 'sms'] as const;
export type OtpChannel = (typeof OTP_CHANNELS)[number];

export const SESSION_REVOKE_REASONS = [
  'logout',
  'logout_all',
  'reuse_detected',
  'admin_revoked',
  'credentials_changed',
  'device_blocked',
  'session_limit',
] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

export const STAFF_ROLES = ['admin', 'staff'] as const satisfies readonly SystemRoleId[];
export type StaffRole = (typeof STAFF_ROLES)[number];

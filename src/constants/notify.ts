export const NOTIFICATION_CHANNELS = ['in_app', 'push', 'whatsapp', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_CATEGORIES = [
  'general',
  'alert',
  'promotional',
  'billing',
  'service',
  'staff',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_DELIVERIES = ['notification', 'both', 'in_app'] as const;
export type NotificationDelivery = (typeof NOTIFICATION_DELIVERIES)[number];

export const NOTIFICATION_STATUS = {
  QUEUED: 'queued',
  SENT: 'sent',
  FAILED: 'failed',
} as const satisfies Record<string, NotificationStatus>;

/**
 * The only category a signed-out device may receive. Everything else is tied to
 * somebody's account, so it needs a live session on that device to be targeted.
 */
export const SIGNED_OUT_CATEGORY: NotificationCategory = 'promotional';

/** What `delivery` a category gets when the caller does not pick one. */
export const DEFAULT_DELIVERY: Record<NotificationCategory, NotificationDelivery> = {
  general: 'notification',
  alert: 'both',
  promotional: 'in_app',
  billing: 'notification',
  service: 'notification',
  staff: 'notification',
};

/** `in_app` never leaves the database — the app pulls it on focus. */
export function sendsPush(delivery: NotificationDelivery): boolean {
  return delivery !== 'in_app';
}

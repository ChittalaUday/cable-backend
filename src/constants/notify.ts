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

export const SIGNED_OUT_CATEGORY: NotificationCategory = 'promotional';

export const DEFAULT_DELIVERY: Record<NotificationCategory, NotificationDelivery> = {
  general: 'notification',
  alert: 'both',
  promotional: 'in_app',
  billing: 'notification',
  service: 'notification',
  staff: 'notification',
};

export function sendsPush(delivery: NotificationDelivery): boolean {
  return delivery !== 'in_app';
}

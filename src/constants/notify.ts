export const NOTIFICATION_CHANNELS = ['in_app', 'whatsapp', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_CHANNEL = {
  IN_APP: 'in_app',
  WHATSAPP: 'whatsapp',
  SMS: 'sms',
} as const satisfies Record<string, NotificationChannel>;

export const NOTIFICATION_STATUS = {
  QUEUED: 'queued',
  SENT: 'sent',
  FAILED: 'failed',
} as const satisfies Record<string, NotificationStatus>;

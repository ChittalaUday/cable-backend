import type { MessageChannel } from '@/services/messaging/messaging.types';

export type { Notification, NotificationChannel, NotificationStatus } from '@/db/schema';

export const TRANSPORT_CHANNELS: readonly MessageChannel[] = ['whatsapp', 'sms'];

export interface NotifyInput {
  channel: 'in_app' | 'whatsapp' | 'sms';
  type: string;
  body: string;
  tenantId?: string | null;
  userId?: string | null;
  title?: string | null;
  data?: Record<string, unknown> | null;
  destination?: string | null;
  sensitive?: boolean;
}

export interface InboxQuery {
  tenantId: string;
  userId: string;
  page: number;
  limit: number;
  unreadOnly?: boolean;
}

export const REDACTED_BODY = '[redacted]';

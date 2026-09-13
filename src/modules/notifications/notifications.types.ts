import type { MessageChannel } from './messaging.types';

export type { Notification, NotificationChannel, NotificationStatus } from '@/db/schema';

/** The channels that leave the system. `in_app` is not one of them. */
export const TRANSPORT_CHANNELS: readonly MessageChannel[] = ['whatsapp', 'sms'];

export interface NotifyInput {
  channel: 'in_app' | 'whatsapp' | 'sms';
  /** Machine key the client switches on: `otp`, `payment_due`, `ticket_assigned`. */
  type: string;
  body: string;
  tenantId?: string | null;
  userId?: string | null;
  title?: string | null;
  data?: Record<string, unknown> | null;
  /** Required for a transport channel; ignored for `in_app`. */
  destination?: string | null;
  /**
   * Store a redacted body instead of the real one. Set for anything carrying a
   * credential — the message still goes out intact, but the row keeps no copy.
   */
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

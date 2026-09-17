import type { NotificationCategory, NotificationDelivery } from '@/constants/notify';

// The vocabulary lives in `@/constants/notify` (mirrored by the app); only the
// row shape comes from the schema.
export type {
  NotificationCategory,
  NotificationChannel,
  NotificationDelivery,
  NotificationStatus,
} from '@/constants/notify';
export type { Notification } from '@/db/schema';

export interface NotifyInput {
  channel: 'in_app' | 'push' | 'whatsapp' | 'sms';
  type: string;
  body: string;
  category?: NotificationCategory;
  delivery?: NotificationDelivery;
  tenantId?: string | null;
  userId?: string | null;
  title?: string | null;
  data?: Record<string, unknown> | null;
  destination?: string | null;
  imageUrl?: string | null;
  sensitive?: boolean;
}

/** Who a broadcast is aimed at. Resolved to device tokens at send time. */
export type Audience
  = | { kind: 'user'; userIds: readonly string[] }
    | { kind: 'role'; roleId: 'admin' | 'staff' | 'customer' }
    | { kind: 'tenant' };

export interface BroadcastInput {
  tenantId: string;
  audience: Audience;
  category: NotificationCategory;
  type: string;
  title: string;
  body: string;
  delivery?: NotificationDelivery;
  data?: Record<string, unknown> | null;
  imageUrl?: string | null;
}

export interface BroadcastResult {
  notified: number;
  pushed: number;
  failed: number;
}

export interface InboxQuery {
  tenantId: string;
  userId: string;
  page: number;
  limit: number;
  unreadOnly?: boolean;
  category?: NotificationCategory;
  delivery?: readonly NotificationDelivery[];
}

export interface RegisterTokenInput {
  clientDeviceId: string;
  platform: 'ios' | 'android' | 'web';
  token: string | null;
  osVersion?: string | null;
  model?: string | null;
  appVersion?: string | null;
  tenantId?: string | null;
}

/** One live push target: a device token plus the user signed in on it, if any. */
export interface PushTarget {
  deviceId: string;
  token: string;
  userId: string | null;
  tenantId: string | null;
}

export const REDACTED_BODY = '[redacted]';

import type { Static } from 'typebox';
import { Type } from 'typebox';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERIES,
  NOTIFICATION_STATUSES,
} from '@/constants/notify';
import { DeviceHeaders } from '@/modules/auth/auth.schema';
import { StringEnum } from '@/types/typebox';
import { paginated, PaginationQuerySchema } from '@/utils/pagination';

export const NotificationCategoryEnum = StringEnum(NOTIFICATION_CATEGORIES);
export const NotificationDeliveryEnum = StringEnum(NOTIFICATION_DELIVERIES);

export const ImageUrl = Type.String({
  format: 'uri',
  pattern: '^https://',
  maxLength: 2048,
  description: 'Must be https — the image is rendered inside other people\'s notification trays.',
});

export const Notification = Type.Object({
  id: Type.String({ format: 'uuid' }),
  category: NotificationCategoryEnum,
  delivery: NotificationDeliveryEnum,
  channel: StringEnum(NOTIFICATION_CHANNELS),
  type: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
  body: Type.String(),
  data: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  imageUrl: Type.Union([Type.String(), Type.Null()]),
  status: StringEnum(NOTIFICATION_STATUSES),
  readAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
});

export const InboxQuery = Type.Object({
  ...PaginationQuerySchema.properties,
  unreadOnly: Type.Optional(Type.Boolean()),
  category: Type.Optional(NotificationCategoryEnum),
  delivery: Type.Optional(Type.String({
    pattern: '^(notification|both|in_app)(,(notification|both|in_app))*$',
    description: 'One mode, or several separated by commas. A device that cannot receive push asks for `in_app,both`, since a `both` message would otherwise never reach it.',
  })),
});

export const InboxResponse = paginated(Notification);

export const UnreadCountResponse = Type.Object({
  total: Type.Integer(),
  byCategory: Type.Record(Type.String(), Type.Integer()),
});

export const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const MarkAllReadBody = Type.Object({
  category: Type.Optional(NotificationCategoryEnum),
});

export const MarkAllReadResponse = Type.Object({ updated: Type.Integer() });

// Registering a push token is deliberately unauthenticated: the app records the
// device on first launch, long before anybody signs in, and keeps the token
// current through sign-out. Identity comes from the device headers, not a token
// — the same set sign-in uses, reused rather than restated so the two cannot
// drift into recording different things about the same device.
export const RegisterTokenHeaders = DeviceHeaders;

export const RegisterTokenBody = Type.Object({
  token: Type.Union([
    Type.String({ minLength: 10, maxLength: 512 }),
    Type.Null(),
  ], { description: 'null clears the token — send it when the user revokes notification permission' }),
});

export const RegisterTokenResponse = Type.Object({ status: Type.Literal('registered') });

export const SendBody = Type.Object({
  audience: StringEnum(['user', 'role', 'tenant'] as const),
  userIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 500 })),
  roleId: Type.Optional(StringEnum(['admin', 'staff', 'customer'] as const)),
  category: NotificationCategoryEnum,
  delivery: Type.Optional(NotificationDeliveryEnum),
  type: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  body: Type.String({ minLength: 1, maxLength: 1000 }),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  imageUrl: Type.Optional(ImageUrl),
});

export const SendResponse = Type.Object({
  notified: Type.Integer(),
  pushed: Type.Integer(),
  failed: Type.Integer(),
});

export type InboxQuery = Static<typeof InboxQuery>;
export type RegisterTokenHeaders = Static<typeof RegisterTokenHeaders>;
export type SendBody = Static<typeof SendBody>;

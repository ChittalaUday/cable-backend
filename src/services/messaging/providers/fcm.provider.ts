import type { Messaging } from 'firebase-admin/messaging';
import type { MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';
import { ERROR_CODES } from '@/errors';
import { DomainError } from '@/errors/domain-error';

export function createFcmProvider(messaging: Messaging): MessagingProvider {
  return {
    name: 'fcm',
    channels: ['push'],
    configured: true,

    async send({ to, text, subject, category, data, imageUrl }: OutboundMessage): Promise<SendResult> {
      try {
        // A `notification` payload, never data-only: the OS then shows this in
        // the tray when the app is backgrounded and stays silent when it is
        // foregrounded, which is exactly the one-or-the-other rule we want.
        const id = await messaging.send({
          token: to,
          notification: {
            title: subject ?? 'Satya Cable',
            body: text,
            // Platform-independent: FCM maps this to Android's big-picture
            // style and to the iOS attachment. iOS only renders it when the
            // app ships a Notification Service Extension.
            ...(imageUrl != null && imageUrl !== '' ? { imageUrl } : {}),
          },
          data: stringValues(data),
          android: {
            priority: category === 'alert' ? 'high' : 'normal',
            notification: { channelId: category ?? 'general' },
          },
          ...(category === 'alert'
            ? { apns: { payload: { aps: { sound: 'default' } } } }
            : {}),
        });

        return { providerMessageId: id };
      }
      catch (cause) {
        throw new DomainError({
          code: ERROR_CODES.OTP_DELIVERY_FAILED,
          statusCode: 502,
          message: `FCM delivery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    },
  };
}

/** FCM data payloads are string-to-string; anything else is dropped silently. */
function stringValues(data: Record<string, unknown> | null | undefined): Record<string, string> {
  if (data == null)
    return {};

  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
  );
}

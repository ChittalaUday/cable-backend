import type { Messaging } from 'firebase-admin/messaging';
import type { MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';
import { ERROR_CODES } from '@/errors';
import { DomainError } from '@/errors/domain-error';

export function createFcmProvider(messaging: Messaging): MessagingProvider {
  return {
    name: 'fcm',
    channels: ['push'],
    configured: true,

    async send({ to, text, subject, category, data, imageUrl, silent }: OutboundMessage): Promise<SendResult> {
      try {
        const id = await messaging.send(silent === true
          ? {
              token: to,
              data: stringValues(data),
              android: { priority: 'high' },
              apns: {
                headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
                payload: { aps: { 'content-available': 1 } },
              },
            }
          : {
              token: to,
              notification: {
                title: subject ?? 'Satya Cable',
                body: text,
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

function stringValues(data: Record<string, unknown> | null | undefined): Record<string, string> {
  if (data == null)
    return {};

  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
  );
}

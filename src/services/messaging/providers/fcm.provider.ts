import type { Messaging } from 'firebase-admin/messaging';
import type { MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';
import { ERROR_CODES } from '@/errors';
import { DomainError } from '@/errors/domain-error';

export function createFcmProvider(messaging: Messaging): MessagingProvider {
  return {
    name: 'fcm',
    channels: ['push'],
    configured: true,

    async send({ to, text, subject }: OutboundMessage): Promise<SendResult> {
      try {
        const id = await messaging.send({
          token: to,
          notification: {
            title: subject ?? 'Satya Cable',
            body: text,
          },
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

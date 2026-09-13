import type { MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';
import { ERROR_CODES } from '@/shared/errors';
import { DomainError } from '@/shared/errors/domain-error';

export interface OpenWaConfig {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  timeoutMs: number;
}

interface OpenWaResponse {
  id?: string;
  messageId?: string;
}

export function createOpenWaProvider(config: OpenWaConfig): MessagingProvider {
  return {
    name: 'openwa',
    channels: ['whatsapp'],
    configured: true,

    async send({ to, text }: OutboundMessage): Promise<SendResult> {
      const url = `${config.baseUrl}/api/sessions/${config.sessionId}/messages/send-text`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-API-Key': config.apiKey },
          body: JSON.stringify({ chatId: `${to}@c.us`, text }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      }
      catch (cause) {
        throw new DomainError({
          code: ERROR_CODES.OTP_DELIVERY_FAILED,
          statusCode: 502,
          message: `OpenWA unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new DomainError({
          code: ERROR_CODES.OTP_DELIVERY_FAILED,
          statusCode: 502,
          message: `OpenWA rejected the message (${response.status}): ${body.slice(0, 200)}`,
        });
      }

      const payload = await response.json().catch(() => ({})) as OpenWaResponse;
      return { providerMessageId: payload.id ?? payload.messageId ?? null };
    },
  };
}

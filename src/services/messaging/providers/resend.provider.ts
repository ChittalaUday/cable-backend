import type { MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';
import { ERROR_CODES } from '@/errors';
import { DomainError } from '@/errors/domain-error';

export interface ResendConfig {
  apiKey: string;
  /** Verified sender, e.g. `Satya Cable <no-reply@satyacable.in>`. */
  from: string;
  timeoutMs: number;
}

const ENDPOINT = 'https://api.resend.com/emails';

function failed(message: string): DomainError {
  return new DomainError({ code: ERROR_CODES.OTP_DELIVERY_FAILED, statusCode: 502, message });
}

/**
 * Sending one email is a single POST, so this talks to the API directly rather
 * than pulling in the SDK for it.
 */
export function createResendProvider(config: ResendConfig): MessagingProvider {
  return {
    name: 'resend',
    channels: ['email'],
    configured: config.apiKey !== '' && config.from !== '',

    async send({ to, text, subject }: OutboundMessage): Promise<SendResult> {
      let response: Response;

      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: config.from,
            to: [to],
            subject: subject ?? 'Your Satya Cable verification code',
            text,
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      }
      catch (cause) {
        throw failed(`Resend unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw failed(`Resend rejected the message (${response.status}): ${body.slice(0, 200)}`);
      }

      const payload = await response.json().catch(() => ({})) as { id?: string };
      return { providerMessageId: payload.id ?? null };
    },
  };
}

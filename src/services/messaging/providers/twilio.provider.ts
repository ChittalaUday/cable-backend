import type { MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';
import { Buffer } from 'node:buffer';
import { ERROR_CODES } from '@/errors';
import { DomainError } from '@/errors/domain-error';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** An E.164 number, or a Messaging Service SID beginning `MG`. */
  from: string;
  timeoutMs: number;
}

function failed(message: string): DomainError {
  return new DomainError({ code: ERROR_CODES.OTP_DELIVERY_FAILED, statusCode: 502, message });
}

/** Twilio addresses WhatsApp with a `whatsapp:` prefix and SMS without one. */
function address(value: string, channel: OutboundMessage['channel']): string {
  const e164 = value.startsWith('+') || value.startsWith('MG') ? value : `+${value}`;
  return channel === 'whatsapp' ? `whatsapp:${e164}` : e164;
}

/**
 * One POST per message, so this uses the REST API directly rather than adding
 * the SDK. Twilio wants form encoding, not JSON.
 */
export function createTwilioProvider(config: TwilioConfig): MessagingProvider {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');

  return {
    name: 'twilio',
    channels: ['sms'],
    configured: config.accountSid !== '' && config.authToken !== '' && config.from !== '',

    async send({ to, text, channel }: OutboundMessage): Promise<SendResult> {
      const form = new URLSearchParams({
        To: address(to, channel),
        Body: text,
        ...(config.from.startsWith('MG')
          ? { MessagingServiceSid: config.from }
          : { From: address(config.from, channel) }),
      });

      let response: Response;

      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'authorization': `Basic ${auth}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      }
      catch (cause) {
        throw failed(`Twilio unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw failed(`Twilio rejected the message (${response.status}): ${body.slice(0, 200)}`);
      }

      const payload = await response.json().catch(() => ({})) as { sid?: string };
      return { providerMessageId: payload.sid ?? null };
    },
  };
}

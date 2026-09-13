import type { MessageChannel, MessagingProvider, OutboundMessage, SendResult } from './messaging.types';
import { ERROR_CODES } from '@/shared/errors';
import { DomainError } from '@/shared/errors/domain-error';

export interface MessagingServiceOptions {
  providers: MessagingProvider[];
  defaultChannel: MessageChannel;
  defaultCountryCode: string;
}

/**
 * Picks a provider for a channel and normalises the destination.
 *
 * Callers ask for a channel, never for a vendor — that is what makes an SMS
 * gateway a drop-in later (AGENTS.md §1).
 */
export class MessagingService {
  private readonly byChannel = new Map<MessageChannel, MessagingProvider>();

  constructor(private readonly options: MessagingServiceOptions) {
    // First provider registered for a channel wins, so ordering in the plugin
    // is the precedence and there is no hidden priority rule.
    for (const provider of options.providers) {
      for (const channel of provider.channels) {
        if (!this.byChannel.has(channel))
          this.byChannel.set(channel, provider);
      }
    }
  }

  get defaultChannel(): MessageChannel {
    return this.options.defaultChannel;
  }

  supports(channel: MessageChannel): boolean {
    return this.byChannel.has(channel);
  }

  async send(message: Omit<OutboundMessage, 'channel'> & { channel?: MessageChannel }): Promise<SendResult> {
    const channel = message.channel ?? this.options.defaultChannel;
    const provider = this.byChannel.get(channel);

    if (!provider) {
      throw new DomainError({
        code: ERROR_CODES.OTP_CHANNEL_UNAVAILABLE,
        statusCode: 503,
        message: `No provider configured for channel "${channel}"`,
      });
    }

    return provider.send({
      ...message,
      channel,
      to: normalisePhone(message.to, this.options.defaultCountryCode),
    });
  }
}

/**
 * Reduce a phone number to the digits a gateway expects: E.164 without `+`.
 *
 * A bare national number is prefixed with the default country code. Numbers are
 * stored and entered inconsistently (`+91 83091 54716`, `08309154716`,
 * `8309154716`), and a gateway silently drops anything it cannot parse.
 */
export function normalisePhone(raw: string, defaultCountryCode: string): string {
  const digits = raw.replace(/\D/g, '');

  if (raw.trim().startsWith('+'))
    return digits;

  if (digits.startsWith(defaultCountryCode))
    return digits;

  // A single leading 0 is the national trunk prefix, not part of the number.
  const national = digits.replace(/^0+/, '');
  return `${defaultCountryCode}${national}`;
}

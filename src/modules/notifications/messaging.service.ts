import type { MessageChannel, MessagingProvider, OutboundMessage, SendResult } from './messaging.types';
import { ERROR_CODES } from '@/shared/errors';
import { DomainError } from '@/shared/errors/domain-error';

/** Channels whose destination is a phone number and therefore normalisable. */
const PHONE_CHANNELS = new Set<MessageChannel>(['whatsapp', 'sms']);

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
    // First provider registered for a channel wins, so ordering in the plugin is
    // the precedence and there is no hidden priority rule. A configured provider
    // always beats a placeholder, whatever the order — otherwise a stale
    // placeholder registration could silently disable a working gateway.
    for (const provider of options.providers) {
      for (const channel of provider.channels) {
        const current = this.byChannel.get(channel);
        if (!current || (!current.configured && provider.configured))
          this.byChannel.set(channel, provider);
      }
    }
  }

  get defaultChannel(): MessageChannel {
    return this.options.defaultChannel;
  }

  /** True only when a provider can actually deliver — a placeholder does not count. */
  supports(channel: MessageChannel): boolean {
    return this.byChannel.get(channel)?.configured === true;
  }

  /** Channels that are routed at all, configured or not. */
  get knownChannels(): MessageChannel[] {
    return [...this.byChannel.keys()];
  }

  /** Name of the provider handling a channel, for logs and diagnostics. */
  providerFor(channel: MessageChannel): string | null {
    return this.byChannel.get(channel)?.name ?? null;
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
      // Only the phone channels take a phone number; an address or a device
      // token must survive untouched.
      to: PHONE_CHANNELS.has(channel)
        ? normalisePhone(message.to, this.options.defaultCountryCode)
        : message.to,
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

/**
 * Reduce a phone number to 10-digit Indian mobile number for storage in `users.phone`.
 */
export function to10DigitPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91'))
    return digits.slice(2);

  if (digits.length === 11 && digits.startsWith('0'))
    return digits.slice(1);

  return digits;
}

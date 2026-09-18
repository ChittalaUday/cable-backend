import type { MessageChannel, MessagingProvider, OutboundMessage, SendResult } from './messaging.types';
import { ERROR_CODES } from '@/errors';
import { DomainError } from '@/errors/domain-error';

const PHONE_CHANNELS = new Set<MessageChannel>(['whatsapp', 'sms']);

/** Where a phone channel falls back to when its own provider is down. */
const PHONE_FALLBACK: Partial<Record<MessageChannel, MessageChannel>> = {
  whatsapp: 'sms',
  sms: 'whatsapp',
};

export interface MessagingServiceOptions {
  providers: MessagingProvider[];
  defaultChannel: MessageChannel;
  defaultCountryCode: string;
  /** Consecutive failures that take a channel out of rotation. Default 3. */
  breakerFailures?: number;
  /** How long a tripped channel stays out before it is retried. Default 120s. */
  breakerCooldownMs?: number;
}

export class MessagingService {
  private readonly byChannel = new Map<MessageChannel, MessagingProvider>();

  /**
   * One counter per channel, in memory on purpose.
   *
   * A provider being down is a passing condition, so the state that records it
   * should pass too: after `breakerCooldownMs` the channel is tried once more
   * and a single success clears it. Persisting it would mean a ten-minute
   * outage kept a channel switched off until somebody noticed and re-enabled
   * it by hand.
   */
  private readonly failures = new Map<MessageChannel, { count: number; trippedAt: number }>();

  constructor(private readonly options: MessagingServiceOptions) {
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

  /** Configured at boot — says nothing about whether it is answering now. */
  supports(channel: MessageChannel): boolean {
    return this.byChannel.get(channel)?.configured === true;
  }

  /** Configured *and* not currently tripped, which is what a caller can use. */
  available(channel: MessageChannel): boolean {
    return this.supports(channel) && !this.isTripped(channel);
  }

  /** Every channel a client may ask for right now, in preference order. */
  get liveChannels(): MessageChannel[] {
    return [...this.byChannel.keys()].filter(channel => this.available(channel));
  }

  private isTripped(channel: MessageChannel): boolean {
    const state = this.failures.get(channel);

    if (state === undefined || state.count < (this.options.breakerFailures ?? 3))
      return false;

    if (Date.now() - state.trippedAt < (this.options.breakerCooldownMs ?? 120_000))
      return true;

    // Cooldown is over: let the next send through and judge by its result.
    this.failures.delete(channel);
    return false;
  }

  private recordFailure(channel: MessageChannel): void {
    const state = this.failures.get(channel) ?? { count: 0, trippedAt: 0 };
    this.failures.set(channel, { count: state.count + 1, trippedAt: Date.now() });
  }

  get knownChannels(): MessageChannel[] {
    return [...this.byChannel.keys()];
  }

  providerFor(channel: MessageChannel): string | null {
    return this.byChannel.get(channel)?.name ?? null;
  }

  /**
   * Send on the channel asked for, or on its sibling when that one is down.
   *
   * A channel with no provider at all is a misconfiguration, not an outage, so
   * it still raises rather than quietly going out another way. Falling back is
   * for a channel that *was* configured and is tripped or failing: the other
   * phone channel reaches the same number, so using it beats not sending. The
   * result names the channel that carried the message, so the caller can tell
   * the user where to look. Email and push have no sibling.
   */
  async send(message: Omit<OutboundMessage, 'channel'> & { channel?: MessageChannel }): Promise<SendResult & { channel: MessageChannel }> {
    const asked = message.channel ?? this.options.defaultChannel;

    if (!this.supports(asked)) {
      throw new DomainError({
        code: ERROR_CODES.OTP_CHANNEL_UNAVAILABLE,
        statusCode: 503,
        message: `No provider configured for channel "${asked}"`,
      });
    }

    const sibling = PHONE_FALLBACK[asked];
    const fallback = sibling !== undefined && this.supports(sibling) ? [sibling] : [];

    // A tripped channel goes last rather than being dropped: if the sibling
    // fails too, it is still better to try than to send nothing.
    const order = this.isTripped(asked) && fallback.length > 0
      ? [...fallback, asked]
      : [asked, ...fallback];

    let lastError: unknown;

    for (const channel of order) {
      try {
        const result = await this.byChannel.get(channel)!.send({
          ...message,
          channel,
          to: PHONE_CHANNELS.has(channel)
            ? normalisePhone(message.to, this.options.defaultCountryCode)
            : message.to,
        });

        this.failures.delete(channel);
        return { ...result, channel };
      }
      catch (error) {
        this.recordFailure(channel);
        lastError = error;
      }
    }

    throw lastError;
  }
}

export function normalisePhone(raw: string, defaultCountryCode: string): string {
  const digits = raw.replace(/\D/g, '');

  if (raw.trim().startsWith('+'))
    return digits;

  if (digits.startsWith(defaultCountryCode))
    return digits;

  const national = digits.replace(/^0+/, '');
  return `${defaultCountryCode}${national}`;
}

export function to10DigitPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91'))
    return digits.slice(2);

  if (digits.length === 11 && digits.startsWith('0'))
    return digits.slice(1);

  return digits;
}

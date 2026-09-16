import type { MessageChannel, MessagingProvider, OutboundMessage, SendResult } from './messaging.types';
import { ERROR_CODES } from '@/errors';
import { DomainError } from '@/errors/domain-error';

const PHONE_CHANNELS = new Set<MessageChannel>(['whatsapp', 'sms']);

export interface MessagingServiceOptions {
  providers: MessagingProvider[];
  defaultChannel: MessageChannel;
  defaultCountryCode: string;
}

export class MessagingService {
  private readonly byChannel = new Map<MessageChannel, MessagingProvider>();

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

  supports(channel: MessageChannel): boolean {
    return this.byChannel.get(channel)?.configured === true;
  }

  get knownChannels(): MessageChannel[] {
    return [...this.byChannel.keys()];
  }

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
      to: PHONE_CHANNELS.has(channel)
        ? normalisePhone(message.to, this.options.defaultCountryCode)
        : message.to,
    });
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

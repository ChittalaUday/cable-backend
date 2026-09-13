import type { MessageChannel, MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';
import { ERROR_CODES } from '@/shared/errors';
import { DomainError } from '@/shared/errors/domain-error';

export interface PlaceholderConfig {
  channel: MessageChannel;
  requiredEnv: string[];
  plannedProvider?: string;
}

export function createPlaceholderProvider(config: PlaceholderConfig): MessagingProvider {
  const planned = config.plannedProvider != null && config.plannedProvider !== ''
    ? ` (planned: ${config.plannedProvider})`
    : '';
  const required = config.requiredEnv.length > 0 ? ` Set ${config.requiredEnv.join(', ')}.` : '';

  return {
    name: `placeholder:${config.channel}`,
    channels: [config.channel],
    configured: false,

    async send(_message: OutboundMessage): Promise<SendResult> {
      throw new DomainError({
        code: ERROR_CODES.OTP_CHANNEL_UNAVAILABLE,
        statusCode: 503,
        message: `Channel "${config.channel}" has no provider configured${planned}.${required}`,
      });
    },
  };
}

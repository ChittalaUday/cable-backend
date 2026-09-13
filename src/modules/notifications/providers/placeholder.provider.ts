import type { MessageChannel, MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';
import { ERROR_CODES } from '@/shared/errors';
import { DomainError } from '@/shared/errors/domain-error';

export interface PlaceholderConfig {
  channel: MessageChannel;
  /** What has to be set before this channel can deliver. Named in the error. */
  requiredEnv: string[];
  /** The intended vendor, when one is already decided. */
  plannedProvider?: string;
}

/**
 * Holds a channel open that has no provider yet (AGENTS.md §1).
 *
 * Registering this instead of leaving the channel absent means a send fails with
 * "email is not configured, set RESEND_API_KEY" rather than "unknown channel".
 * The first is a deployment checklist item; the second reads like a typo, and
 * the difference is an afternoon of debugging.
 *
 * It reports `configured: false`, so `MessagingService.supports()` still answers
 * honestly and a caller can fall back to another channel before trying.
 */
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

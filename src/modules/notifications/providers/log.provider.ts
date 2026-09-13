import type { MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';

export type LogSink = (line: string, message: OutboundMessage) => void;

/**
 * Writes the message instead of sending it. Used by tests and local development
 * so the suite never touches the network and no real message is delivered.
 *
 * `sent` is kept so a test can assert what would have gone out.
 */
export function createLogProvider(sink: LogSink): MessagingProvider & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];

  return {
    name: 'log',
    channels: ['whatsapp', 'sms'],
    sent,

    async send(message: OutboundMessage): Promise<SendResult> {
      sent.push(message);
      sink(`[messaging:log] ${message.channel} → ${message.to}: ${message.text}`, message);
      return { providerMessageId: null };
    },
  };
}

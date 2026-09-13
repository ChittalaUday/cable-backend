import type { MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';
import { MESSAGE_CHANNELS } from '../messaging.types';

export type LogSink = (line: string, message: OutboundMessage) => void;

export function createLogProvider(sink: LogSink): MessagingProvider & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];

  return {
    name: 'log',
    channels: MESSAGE_CHANNELS,
    configured: true,
    sent,

    async send(message: OutboundMessage): Promise<SendResult> {
      sent.push(message);
      sink(`[messaging:log] ${message.channel} → ${message.to}: ${message.text}`, message);
      return { providerMessageId: null };
    },
  };
}

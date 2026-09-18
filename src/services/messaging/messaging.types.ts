export const MESSAGE_CHANNELS = ['whatsapp', 'sms', 'email', 'push'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export interface OutboundMessage {
  to: string;
  text: string;
  channel: MessageChannel;
  subject?: string;
  category?: string;
  data?: Record<string, unknown> | null;
  imageUrl?: string | null;
  silent?: boolean;
}

export interface SendResult {
  providerMessageId: string | null;
}

export interface MessagingProvider {
  readonly name: string;
  readonly channels: readonly MessageChannel[];
  readonly configured: boolean;
  send: (message: OutboundMessage) => Promise<SendResult>;
}

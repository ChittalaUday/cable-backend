export const MESSAGE_CHANNELS = ['whatsapp', 'sms', 'email', 'push'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export interface OutboundMessage {
  to: string;
  text: string;
  channel: MessageChannel;
  subject?: string;
  /** Push only: the Android notification channel to file this under. */
  category?: string;
  /** Push only: travels alongside the notification for the app to route on. */
  data?: Record<string, unknown> | null;
  /** Push only: an https image rendered inside the notification. */
  imageUrl?: string | null;
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

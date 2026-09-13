/**
 * Messaging is a service with pluggable providers (AGENTS.md §1 rule 1).
 *
 * One file knows each vendor. Swapping WhatsApp for an SMS gateway is a new
 * provider plus an env change — no caller changes, and tests substitute a fake
 * without touching the network.
 */

export const MESSAGE_CHANNELS = ['whatsapp', 'sms'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export interface OutboundMessage {
  /** Destination in E.164 digits, no `+` (normalised by the service). */
  to: string;
  text: string;
  channel: MessageChannel;
}

export interface SendResult {
  /** The provider's own id, when it returns one. Logged for support lookups. */
  providerMessageId: string | null;
}

export interface MessagingProvider {
  readonly name: string;
  /** Channels this provider can actually deliver. */
  readonly channels: readonly MessageChannel[];
  send: (message: OutboundMessage) => Promise<SendResult>;
}

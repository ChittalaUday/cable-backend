/**
 * Messaging is a service with pluggable providers (AGENTS.md §1 rule 1).
 *
 * One file knows each vendor. Callers pick a CHANNEL and never a provider, so
 * adding a gateway is a new provider file plus an env var — no caller changes,
 * and tests substitute a fake without touching the network.
 */

/** Channels that leave the system. `in_app` is not one — see notifications.types.ts. */
export const MESSAGE_CHANNELS = ['whatsapp', 'sms', 'email', 'push'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export interface OutboundMessage {
  /**
   * Where it goes. A phone in E.164 digits for `whatsapp`/`sms`, an address for
   * `email`, a device token for `push`.
   */
  to: string;
  text: string;
  channel: MessageChannel;
  /** Used by `email` and `push`; ignored by the text-only channels. */
  subject?: string;
}

export interface SendResult {
  /** The provider's own id, when it returns one. Logged for support lookups. */
  providerMessageId: string | null;
}

export interface MessagingProvider {
  readonly name: string;
  /** Channels this provider is responsible for. */
  readonly channels: readonly MessageChannel[];
  /**
   * False for a reserved-but-unwired channel. The channel is known and routed,
   * it just cannot deliver yet — which is a different failure from an unknown
   * channel, and clients deserve to be able to tell them apart.
   */
  readonly configured: boolean;
  send: (message: OutboundMessage) => Promise<SendResult>;
}

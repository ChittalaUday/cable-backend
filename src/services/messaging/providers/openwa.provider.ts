import type { MessagingProvider, OutboundMessage, SendResult } from '../messaging.types';
import { ERROR_CODES } from '@/errors';
import { DomainError } from '@/errors/domain-error';

export interface OpenWaConfig {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  timeoutMs: number;
  /** How long to wait for a restarted session to come back before giving up. */
  recoveryTimeoutMs?: number;
  /**
   * Called when the session cannot be recovered without a person — it needs a
   * QR scan, or it failed outright. Fire-and-forget: delivery has already
   * failed by this point and the alert must not delay the response further.
   */
  onSessionUnrecoverable?: (detail: { status: string; reason: string }) => void;
}

interface OpenWaResponse {
  id?: string;
  messageId?: string;
}

/** Only `ready` can send. The rest are either in transit or need a human. */
type SessionStatus
  = 'created' | 'initializing' | 'qr_ready' | 'authenticating' | 'ready' | 'disconnected' | 'failed';

const NEEDS_A_PERSON = new Set<SessionStatus>(['qr_ready', 'failed']);
const POLL_INTERVAL_MS = 750;

export function createOpenWaProvider(config: OpenWaConfig): MessagingProvider {
  const recoveryTimeoutMs = config.recoveryTimeoutMs ?? 10_000;
  const headers = { 'content-type': 'application/json', 'X-API-Key': config.apiKey };
  const session = `${config.baseUrl}/api/sessions/${config.sessionId}`;

  async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${session}${path}`, {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  }

  async function statusNow(): Promise<SessionStatus | null> {
    try {
      const response = await fetch(session, { headers, signal: AbortSignal.timeout(config.timeoutMs) });
      if (!response.ok)
        return null;

      const payload = await response.json() as { status?: SessionStatus };
      return payload.status ?? null;
    }
    catch {
      return null;
    }
  }

  /**
   * Starts a dormant session and waits for it to come back.
   *
   * A WhatsApp session drops on its own — the phone loses network, the host
   * restarts — and the only thing needed is a restart. Doing that here means
   * one OTP arrives a few seconds late instead of not at all. It gives up
   * immediately on a state no restart can fix: `qr_ready` wants somebody to
   * scan a code, and `failed` wants somebody to look.
   */
  async function recover(): Promise<boolean> {
    try {
      await post('/start');
    }
    catch {
      // The session may already be starting; the poll below decides.
    }

    const deadline = Date.now() + recoveryTimeoutMs;

    while (Date.now() < deadline) {
      const status = await statusNow();

      if (status === 'ready')
        return true;

      if (status !== null && NEEDS_A_PERSON.has(status)) {
        config.onSessionUnrecoverable?.({
          status,
          reason: status === 'qr_ready'
            ? 'WhatsApp needs its QR code scanned again before any message can be sent.'
            : 'The WhatsApp session failed to start.',
        });
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    config.onSessionUnrecoverable?.({
      status: (await statusNow()) ?? 'unknown',
      reason: 'The WhatsApp session did not come back after being restarted.',
    });

    return false;
  }

  async function sendText(to: string, text: string): Promise<Response> {
    try {
      return await post('/messages/send-text', { chatId: `${to}@c.us`, text });
    }
    catch (cause) {
      throw new DomainError({
        code: ERROR_CODES.OTP_DELIVERY_FAILED,
        statusCode: 502,
        message: `OpenWA unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  return {
    name: 'openwa',
    channels: ['whatsapp'],
    configured: true,

    async send({ to, text }: OutboundMessage): Promise<SendResult> {
      let response = await sendText(to, text);

      if (isSessionInactive(response.status, await peek(response))) {
        if (await recover())
          response = await sendText(to, text);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new DomainError({
          code: ERROR_CODES.OTP_DELIVERY_FAILED,
          statusCode: 502,
          message: `OpenWA rejected the message (${response.status}): ${body.slice(0, 200)}`,
        });
      }

      const payload = await response.json().catch(() => ({})) as OpenWaResponse;
      return { providerMessageId: payload.id ?? payload.messageId ?? null };
    },
  };
}

/** Reads the body without consuming it for the error path that may follow. */
async function peek(response: Response): Promise<string> {
  if (response.ok)
    return '';

  return response.clone().text().catch(() => '');
}

function isSessionInactive(status: number, body: string): boolean {
  return status === 400 && /is not active|start the session/i.test(body);
}

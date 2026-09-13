import type { MessagingProvider } from '@/modules/notifications';
import fp from 'fastify-plugin';
import { env, isTest } from '@/config/env';
import { createLogProvider, createOpenWaProvider, MessagingService } from '@/modules/notifications';

declare module 'fastify' {
  interface FastifyInstance {
    messaging: MessagingService;
  }
}

/**
 * Wires the messaging providers (AGENTS.md §1).
 *
 * `MESSAGING_ENABLED=false` and test runs get the log provider, so no suite and
 * no local run ever delivers a real message. That is the kill switch rule — it
 * flips without a deploy.
 */
export default fp(async (app) => {
  const providers: MessagingProvider[] = [];

  if (env.MESSAGING_ENABLED && !isTest) {
    providers.push(createOpenWaProvider({
      baseUrl: env.MESSAGING_BASE_URL.replace(/\/+$/, ''),
      apiKey: env.MESSAGING_API_KEY,
      sessionId: env.MESSAGING_SESSION_ID,
      timeoutMs: env.MESSAGING_TIMEOUT_MS,
    }));
  }

  // Always last: it only serves channels no real provider claimed.
  providers.push(createLogProvider(line => app.log.warn(line)));

  app.decorate('messaging', new MessagingService({
    providers,
    defaultChannel: env.MESSAGING_DEFAULT_CHANNEL,
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE,
  }));
}, { name: 'messaging' });

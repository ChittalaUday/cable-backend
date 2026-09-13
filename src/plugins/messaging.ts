import type { MessagingProvider } from '@/modules/notifications';
import fp from 'fastify-plugin';
import { env, isTest } from '@/config/env';
import {
  createFcmProvider,
  createLogProvider,
  createOpenWaProvider,
  createPlaceholderProvider,
  MessagingService,
  NotificationService,
} from '@/modules/notifications';

declare module 'fastify' {
  interface FastifyInstance {
    messaging: MessagingService;
    notifications: NotificationService;
  }
}

/**
 * Wires the messaging providers and the notification service (AGENTS.md §1).
 *
 * `MESSAGING_ENABLED=false` and every test run fall back to the log provider, so
 * no suite and no local run delivers a real message. That is the §1 kill switch:
 * it flips without a deploy.
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

    if (app.firebase)
      providers.push(createFcmProvider(app.firebase.messaging));

    // Reserved channels with no provider yet. Registering them means a send
    // fails with "set RESEND_API_KEY" rather than "unknown channel".
    providers.push(
      createPlaceholderProvider({ channel: 'sms', requiredEnv: ['SMS_PROVIDER', 'SMS_API_KEY'] }),
      createPlaceholderProvider({ channel: 'email', requiredEnv: ['RESEND_API_KEY'], plannedProvider: 'Resend' }),
      ...(app.firebase
        ? []
        : [createPlaceholderProvider({
            channel: 'push',
            requiredEnv: ['FIREBASE_SERVICE_ACCOUNT_PATH'],
            plannedProvider: 'Firebase Cloud Messaging',
          })]),
    );
  }
  else {
    // Log provider claims every channel, so local and test runs exercise the
    // full routing path without a network call.
    providers.push(createLogProvider(line => app.log.warn(line)));
  }

  const messaging = new MessagingService({
    providers,
    defaultChannel: env.MESSAGING_DEFAULT_CHANNEL,
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE,
  });

  app.decorate('messaging', messaging);
  app.decorate('notifications', new NotificationService(app.db, messaging));
}, { name: 'messaging', dependencies: ['database', 'firebase'] });

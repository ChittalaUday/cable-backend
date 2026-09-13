import type { MessagingProvider } from '@/modules/messaging/messaging.types';
import fp from 'fastify-plugin';
import { env, isTest } from '@/config/env';
import { MessagingService } from '@/modules/messaging/messaging.service';
import { createFcmProvider } from '@/modules/messaging/providers/fcm.provider';
import { createLogProvider } from '@/modules/messaging/providers/log.provider';
import { createOpenWaProvider } from '@/modules/messaging/providers/openwa.provider';
import { createPlaceholderProvider } from '@/modules/messaging/providers/placeholder.provider';
import { NotificationService } from '@/modules/notifications/notifications.service';

declare module 'fastify' {
  interface FastifyInstance {
    messaging: MessagingService;
    notifications: NotificationService;
  }
}

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

import type { MessagingProvider } from '@/services/messaging/messaging.types';
import type { SearchService } from '@/services/search/search.service';
import type { StorageService } from '@/services/storage/storage.service';
import fp from 'fastify-plugin';
import { getMessaging } from 'firebase-admin/messaging';
import { env, isTest } from '@/config/env';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import { CustomerRepository } from '@/modules/customers/customer.repository';
import { CustomerService } from '@/modules/customers/customer.service';
import { InventoryService } from '@/modules/inventory/inventory.service';
import { LocationRepository } from '@/modules/locations/location.repository';
import { LocationsService } from '@/modules/locations/location.service';
import { PackagesService } from '@/modules/packages/package.service';
import { PaymentService } from '@/modules/payments/payment.service';
import { RemotesService } from '@/modules/remotes/remote.service';
import { CoverageService, ServicesService } from '@/modules/services';
import { StaffService, TeamsService } from '@/modules/staff';
import { TenantService } from '@/modules/tenants';
import { firebaseApp } from '@/services/firebase';
import { MessagingService } from '@/services/messaging/messaging.service';
import { createFcmProvider } from '@/services/messaging/providers/fcm.provider';
import { createLogProvider } from '@/services/messaging/providers/log.provider';
import { createOpenWaProvider } from '@/services/messaging/providers/openwa.provider';
import { createPlaceholderProvider } from '@/services/messaging/providers/placeholder.provider';
import { createResendProvider } from '@/services/messaging/providers/resend.provider';
import { createTwilioProvider } from '@/services/messaging/providers/twilio.provider';
import { NotificationService } from '@/services/notifications/notifications.service';
import { searchService } from '@/services/search/search.service';
import { createStorageProvider, createStorageService } from '@/services/storage/storage.service';

declare module 'fastify' {
  interface FastifyInstance {
    customers: CustomerService;
    locations: LocationsService;
    inventory: InventoryService;
    staff: StaffService;
    teams: TeamsService;
    packages: PackagesService;
    payments: PaymentService;
    services: ServicesService;
    coverage: CoverageService;
    remotes: RemotesService;
    tenants: TenantService;
    analytics: AnalyticsService;
    messaging: MessagingService;
    notifications: NotificationService;
    storage: StorageService;
    searchService: SearchService;
  }
}

export default fp(async (app) => {
  const providers: MessagingProvider[] = [];

  let notifications: NotificationService | undefined;
  let lastAlertAt = 0;

  const ALERT_INTERVAL_MS = 15 * 60 * 1000;

  function alertAdminsOnce(detail: { status: string; reason: string }): void {
    if (Date.now() - lastAlertAt < ALERT_INTERVAL_MS || notifications === undefined)
      return;

    lastAlertAt = Date.now();

    notifications.alertAdmins({
      type: 'whatsapp_session_down',
      title: 'WhatsApp is not sending',
      body: `${detail.reason} Customers cannot receive a sign-in code until it is back.`,
    }).then((result) => {
      app.log.error({ status: detail.status, notified: result.notified }, 'whatsapp session needs attention — admins alerted');
    }).catch((error: unknown) => {
      app.log.error({ err: error }, 'whatsapp session needs attention, and the alert could not be sent');
    });
  }

  if (env.MESSAGING_ENABLED && !isTest) {
    providers.push(createOpenWaProvider({
      baseUrl: env.MESSAGING_BASE_URL.replace(/\/+$/, ''),
      apiKey: env.MESSAGING_API_KEY,
      sessionId: env.MESSAGING_SESSION_ID,
      timeoutMs: env.MESSAGING_TIMEOUT_MS,
      onSessionUnrecoverable: alertAdminsOnce,
    }));

    const twilio = createTwilioProvider({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_FROM,
      timeoutMs: env.MESSAGING_TIMEOUT_MS,
    });

    const resend = createResendProvider({
      apiKey: env.RESEND_API_KEY,
      from: env.RESEND_FROM,
      timeoutMs: env.MESSAGING_TIMEOUT_MS,
    });

    const firebase = firebaseApp();

    providers.push(
      twilio.configured
        ? twilio
        : createPlaceholderProvider({ channel: 'sms', requiredEnv: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'], plannedProvider: 'Twilio' }),
      resend.configured
        ? resend
        : createPlaceholderProvider({ channel: 'email', requiredEnv: ['RESEND_API_KEY', 'RESEND_FROM'], plannedProvider: 'Resend' }),
      firebase === null
        ? createPlaceholderProvider({
            channel: 'push',
            requiredEnv: ['FIREBASE_SERVICE_ACCOUNT_PATH'],
            plannedProvider: 'Firebase Cloud Messaging',
          })
        : createFcmProvider(getMessaging(firebase)),
    );
  }
  else {
    providers.push(createLogProvider(line => app.log.warn(line)));
  }

  const messaging = new MessagingService({
    providers,
    defaultChannel: env.MESSAGING_DEFAULT_CHANNEL,
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE,
    breakerFailures: env.MESSAGING_BREAKER_FAILURES,
    breakerCooldownMs: env.MESSAGING_BREAKER_COOLDOWN_SECONDS * 1000,
  });

  const storageProvider = createStorageProvider();
  if (!storageProvider.configured) {
    app.log.warn('Object storage is not configured — file endpoints will return 503.');
  }
  const storage = createStorageService(app.db, storageProvider);
  notifications = new NotificationService(app.db, messaging);

  const customerRepo = new CustomerRepository(app.db);
  const locationRepo = new LocationRepository(app.db);
  const locations = new LocationsService(locationRepo);
  const customers = new CustomerService(customerRepo);
  const inventory = new InventoryService(app.db, locations);
  // The one the request guard resolves against — see plugins/iam.plugin.ts.
  const access = app.access;
  const staff = new StaffService(app.db, locations, access);
  const teams = new TeamsService(app.db, locations, access);
  const packages = new PackagesService(app.db);
  const payments = new PaymentService(app.db, (event) => {
    notifications
      .signal(
        event.tenantId,
        [
          { kind: 'role', roleId: 'admin' },
          { kind: 'role', roleId: 'staff' },
          ...(event.customerUserId === null ? [] : [{ kind: 'user' as const, userIds: [event.customerUserId] }]),
        ],
        { sync: 'payments', collectionId: event.collectionId, customerId: event.customerId },
      )
      .catch((error: unknown) => {
        app.log.error(
          { err: error, collectionId: event.collectionId, tenantId: event.tenantId },
          'payment recorded, but the live update was not delivered',
        );
      });
  });
  const services = new ServicesService(app.db);
  const coverage = new CoverageService(app.db, locations);
  const remotes = new RemotesService(app.db);
  const analytics = new AnalyticsService(app.db);
  const tenants = new TenantService(app.db);

  app.decorate('messaging', messaging);
  app.decorate('notifications', notifications);
  app.decorate('storage', storage);
  app.decorate('searchService', searchService);

  app.decorate('customers', customers);
  app.decorate('locations', locations);
  app.decorate('inventory', inventory);
  app.decorate('staff', staff);
  app.decorate('teams', teams);
  app.decorate('packages', packages);
  app.decorate('payments', payments);
  app.decorate('services', services);
  app.decorate('coverage', coverage);
  app.decorate('remotes', remotes);
  app.decorate('analytics', analytics);
  app.decorate('tenants', tenants);
}, { name: 'services', dependencies: ['db', 'iam'] });

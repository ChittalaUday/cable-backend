import type { MessagingProvider } from '@/services/messaging/messaging.types';
import type { SearchService } from '@/services/search/search.service';
import type { StorageService } from '@/services/storage/storage.service';
import fp from 'fastify-plugin';
import { env, isTest } from '@/config/env';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import { CustomerRepository } from '@/modules/customers/customer.repository';
import { CustomerService } from '@/modules/customers/customer.service';
import { AccessService } from '@/modules/iam/access.service';
import { InventoryService } from '@/modules/inventory/inventory.service';
import { LocationsService } from '@/modules/locations/location.service';
import { PackagesService } from '@/modules/packages/package.service';
import { RemotesService } from '@/modules/remotes/remote.service';
import { CoverageService } from '@/modules/services/coverage.service';
import { ServicesService } from '@/modules/services/service.service';
import { StaffService } from '@/modules/staff/staff.service';
import { TeamsService } from '@/modules/staff/teams.service';
import { MessagingService } from '@/services/messaging/messaging.service';
import { createLogProvider } from '@/services/messaging/providers/log.provider';
import { createOpenWaProvider } from '@/services/messaging/providers/openwa.provider';
import { createPlaceholderProvider } from '@/services/messaging/providers/placeholder.provider';
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
    services: ServicesService;
    coverage: CoverageService;
    remotes: RemotesService;
    analytics: AnalyticsService;
    messaging: MessagingService;
    notifications: NotificationService;
    storage: StorageService;
    searchService: SearchService;
  }
}

export default fp(async (app) => {
  // 1. Cross-cutting shared services
  const providers: MessagingProvider[] = [];

  if (env.MESSAGING_ENABLED && !isTest) {
    providers.push(createOpenWaProvider({
      baseUrl: env.MESSAGING_BASE_URL.replace(/\/+$/, ''),
      apiKey: env.MESSAGING_API_KEY,
      sessionId: env.MESSAGING_SESSION_ID,
      timeoutMs: env.MESSAGING_TIMEOUT_MS,
    }));

    providers.push(
      createPlaceholderProvider({ channel: 'sms', requiredEnv: ['SMS_PROVIDER', 'SMS_API_KEY'] }),
      createPlaceholderProvider({ channel: 'email', requiredEnv: ['RESEND_API_KEY'], plannedProvider: 'Resend' }),
      createPlaceholderProvider({
        channel: 'push',
        requiredEnv: ['FIREBASE_SERVICE_ACCOUNT_PATH'],
        plannedProvider: 'Firebase Cloud Messaging',
      }),
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

  const storageProvider = createStorageProvider();
  if (!storageProvider.configured) {
    app.log.warn('Object storage is not configured — file endpoints will return 503.');
  }
  const storage = createStorageService(app.db, storageProvider);
  const notifications = new NotificationService(app.db, messaging);

  // 2. Domain Services
  const customerRepo = new CustomerRepository(app.db);
  const locations = new LocationsService(app.db);
  const customers = new CustomerService(customerRepo);
  const inventory = new InventoryService(app.db, locations);
  const access = new AccessService(app.db);
  const staff = new StaffService(app.db, locations, access);
  const teams = new TeamsService(app.db, locations, access);
  const packages = new PackagesService(app.db);
  const services = new ServicesService(app.db);
  const coverage = new CoverageService(app.db, locations);
  const remotes = new RemotesService(app.db);
  const analytics = new AnalyticsService(app.db);

  // 3. Decorate Fastify Instance
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
  app.decorate('services', services);
  app.decorate('coverage', coverage);
  app.decorate('remotes', remotes);
  app.decorate('analytics', analytics);
}, { name: 'services', dependencies: ['db'] });

import type { AnalyticsService } from './analytics.service';

declare module 'fastify' {
  interface FastifyInstance {
    analytics: AnalyticsService;
  }
}

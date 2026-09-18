import type { CoverageService } from './services/coverage.service';
import type { ServicesService } from './services/service.service';

declare module 'fastify' {
  interface FastifyInstance {
    services: ServicesService;
    coverage: CoverageService;
  }
}

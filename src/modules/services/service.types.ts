import type { CoverageService } from './coverage.service';
import type { ServicesService } from './service.service';

declare module 'fastify' {
  interface FastifyInstance {
    services: ServicesService;
    coverage: CoverageService;
  }
}

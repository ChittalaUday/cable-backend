import type { CoverageService } from './coverage.service';
import type { ServicesService } from './services.service';

declare module 'fastify' {
  interface FastifyInstance {
    services: ServicesService;
    coverage: CoverageService;
  }
}

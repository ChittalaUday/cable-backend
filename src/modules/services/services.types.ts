import type { CoverageService } from './coverage.service';
import type { ServicesService } from './services.service';

declare module 'fastify' {
  interface FastifyInstance {
    /** Built in `services.routes.ts` — the catalogue: services and their providers. */
    services: ServicesService;
    /** Where each of them is sold (docs/services-providers-packages.md §5). */
    coverage: CoverageService;
  }
}

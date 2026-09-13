import type { LocationsService } from './locations.service';

declare module 'fastify' {
  interface FastifyInstance {
    /** Built once in `locations.routes.ts`, shared by both route files (§3). */
    locations: LocationsService;
  }
}

import type { LocationsService } from './locations.service';

declare module 'fastify' {
  interface FastifyInstance {
    locations: LocationsService;
  }
}

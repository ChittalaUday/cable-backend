import type { LocationsService } from './location.service';

declare module 'fastify' {
  interface FastifyInstance {
    locations: LocationsService;
  }
}

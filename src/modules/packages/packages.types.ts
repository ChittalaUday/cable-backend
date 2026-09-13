import type { PackagesService } from './packages.service';

declare module 'fastify' {
  interface FastifyInstance {
    /** Built in `packages.routes.ts` — packages and the channel lineups they carry. */
    packages: PackagesService;
  }
}

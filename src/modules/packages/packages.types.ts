import type { PackagesService } from './packages.service';

declare module 'fastify' {
  interface FastifyInstance {
    packages: PackagesService;
  }
}

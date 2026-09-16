import type { PackagesService } from './package.service';

declare module 'fastify' {
  interface FastifyInstance {
    packages: PackagesService;
  }
}

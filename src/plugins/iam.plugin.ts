import fp from 'fastify-plugin';
import { AccessService } from '@/modules/iam/access.service';

declare module 'fastify' {
  interface FastifyInstance {
    access: AccessService;
  }
}

/**
 * One `AccessService` for the whole app.
 *
 * It caches a resolved `AccessContext` per user and tenant, and the staff and
 * teams services call `invalidate()` the moment a grant moves. A second
 * instance anywhere would hold a second cache: the write would clear one map
 * while the request guard kept reading the other, and a re-assigned engineer
 * would keep their old areas until the TTL ran out. It lives in its own plugin
 * because both `request-context` and `services` need it, and those two cannot
 * depend on each other.
 */
export default fp(async (app) => {
  app.decorate('access', new AccessService(app.db));
}, { name: 'iam', dependencies: ['db'] });

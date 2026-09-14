import fp from 'fastify-plugin';
import { CustomersService } from '@/modules/customers/customers.service';

declare module 'fastify' {
  interface FastifyInstance {
    customers: CustomersService;
  }
}

/**
 * The customers service, decorated app-wide.
 *
 * It lives here rather than in `customers.routes.ts` because `/auth/me` embeds a
 * subscriber's profile and so needs `app.customers` from a different module's
 * scope. Decorating from the route file would mean wrapping it in
 * `fastify-plugin`, and an `fp` route plugin never receives the autoload's
 * `/api/v1` prefix — the routes would quietly register at the root.
 */
export default fp(async (app) => {
  app.decorate('customers', new CustomersService(app.db));
}, { name: 'customers', dependencies: ['database'] });

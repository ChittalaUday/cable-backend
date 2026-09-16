import fp from 'fastify-plugin';
import { CustomersService } from '@/modules/customers/customers.service';

declare module 'fastify' {
  interface FastifyInstance {
    customers: CustomersService;
  }
}

export default fp(async (app) => {
  app.decorate('customers', new CustomersService(app.db));
}, { name: 'customers', dependencies: ['database'] });

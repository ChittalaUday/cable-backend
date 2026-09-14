import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import fp from 'fastify-plugin';
import { CustomersService } from './customers.service';

declare module 'fastify' {
  interface FastifyInstance {
    customers: CustomersService;
  }
}

const plugin: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('customers', new CustomersService(app.db));
};

export default fp(plugin, { name: 'customers', dependencies: ['database'] });

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import catalogueRoutes from './catalogue';
import coverageRoutes from './coverage';
import providerRoutes from './providers';

/** Every route file in this folder, in one plugin. */
const routes: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(catalogueRoutes);
  await app.register(providerRoutes);
  await app.register(coverageRoutes);
};

export default routes;

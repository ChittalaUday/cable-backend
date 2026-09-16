import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import configRoutes from './config';
import treeRoutes from './tree';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(configRoutes);
  await app.register(treeRoutes);
};

export default routes;

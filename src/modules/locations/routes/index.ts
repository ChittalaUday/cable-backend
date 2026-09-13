import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import configRoutes from './config';
import treeRoutes from './tree';

/**
 * Every route file in this folder, in one plugin.
 *
 * The module's entry (`locations.routes.ts`) builds the service and registers
 * this, so the split into "the hierarchy definition" and "the tree" stays a
 * detail of the module rather than something the app has to know about.
 */
const routes: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(configRoutes);
  await app.register(treeRoutes);
};

export default routes;

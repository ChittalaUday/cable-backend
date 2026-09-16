import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { LocationsService } from './location.service';
import routeFiles from './routes';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('locations', new LocationsService(app.db));

  await app.register(routeFiles);
};

export default routes;

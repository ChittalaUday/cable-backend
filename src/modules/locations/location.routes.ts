import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { LocationRepository } from './location.repository';
import { LocationsService } from './location.service';
import routeFiles from './routes';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const locationRepo = new LocationRepository(app.db);
  app.decorate('locations', new LocationsService(locationRepo));

  await app.register(routeFiles);
};

export default routes;

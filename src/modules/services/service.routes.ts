import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { LocationsService } from '@/modules/locations/location.service';
import routeFiles from './routes';
import { CoverageService } from './services/coverage.service';
import { ServicesService } from './services/service.service';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('services', new ServicesService(app.db));
  app.decorate('coverage', new CoverageService(app.db, new LocationsService(app.db)));

  await app.register(routeFiles);
};

export default routes;

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { LocationsService } from '@/modules/locations/locations.service';
import { CoverageService } from './coverage.service';
import routeFiles from './routes';
import { ServicesService } from './services.service';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('services', new ServicesService(app.db));
  app.decorate('coverage', new CoverageService(app.db, new LocationsService(app.db)));

  await app.register(routeFiles);
};

export default routes;

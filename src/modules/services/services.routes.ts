import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { LocationsService } from '@/modules/locations/locations.service';
import { CoverageService } from './coverage.service';
import routeFiles from './routes';
import { ServicesService } from './services.service';

/**
 * The module's entry point: build the services once, register the route files
 * in `routes/` (AGENTS.md §3).
 *
 * Coverage points at the location tree, so it takes the locations module's
 * service rather than querying `geo` itself — cross-module access goes through
 * the other module's service (§3). Both are stateless, so building one here
 * costs nothing.
 */
const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('services', new ServicesService(app.db));
  app.decorate('coverage', new CoverageService(app.db, new LocationsService(app.db)));

  await app.register(routeFiles);
};

export default routes;

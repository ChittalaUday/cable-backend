import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { LocationsService } from './locations.service';
import routeFiles from './routes';

/**
 * The module's entry point: build the service once, then register the route
 * files in `routes/` (AGENTS.md §3).
 *
 * Autoload registers this file and nothing else in the module — the files under
 * `routes/` are plain plugins, so the wiring stays in one place a reader can
 * find instead of in a `plugins/` file that exists only to call a constructor.
 */
const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('locations', new LocationsService(app.db));

  await app.register(routeFiles);
};

export default routes;

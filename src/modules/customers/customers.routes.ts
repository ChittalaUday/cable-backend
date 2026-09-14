import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from './customers.controller';
import {
  CustomerDetailResponse,
  CustomerPageResponse,
  IdParams,
  ListCustomersQuery,
} from './customers.schema';

/**
 * The staff view of customers: a cheap list, and one call that draws a page.
 *
 * Both are `customers.view`, so the SCOPE on the grant decides what comes back
 * rather than a second endpoint per role — an admin's `ALL` returns the tenant,
 * a field operator's `LOCATION` returns their areas, and a subscriber's `OWN`
 * returns themselves. One route, three answers, no way to forget one of them.
 */
const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef };

  app.get('/customers', {
    preHandler: app.requirePermission(PERMISSIONS.CUSTOMERS_VIEW),
    schema: {
      tags: ['customers'],
      summary: 'A page of customers, ready to render',
      description: [
        'Every row includes all searchable customer, service-account, location and equipment values, so the client never performs follow-up lookups.',
        '',
        'With `q`, the same response shape is ranked by fuzzy relevance and includes `matchedFields` and `score`.',
        '',
        '`q` performs ranked fuzzy search across customer identity, account numbers, addresses, location paths/codes and service equipment identifiers.',
        '',
        'Paging is by `cursor`, not page number: pass back `nextCursor` until it is null. At 300k rows a page-50000 offset costs 89ms and keyset costs 0.03ms, and a cursor cannot skip or repeat rows when someone inserts while you scroll. `total` comes back on the first page only.',
      ].join('\n'),
      querystring: ListCustomersQuery,
      response: { 200: CustomerPageResponse, ...errors },
    },
  }, controller.list);

  app.get('/customers/:id', {
    preHandler: app.requirePermission(PERMISSIONS.CUSTOMERS_VIEW),
    schema: {
      tags: ['customers'],
      summary: 'Everything a customer details page draws, in one response',
      description: [
        'A customer id is a handle onto a graph — subscriptions, and through each one a provider, a package, a service and a location.',
        '',
        'This resolves the whole graph server-side, where the joins are indexed, so the client makes no follow-up calls to `/packages/:id`, `/service-providers/:id` or `/locations/:id`.',
        '',
        'Out of your area answers 404 rather than 403: whether a customer exists elsewhere is not something the caller should learn.',
      ].join('\n'),
      params: IdParams,
      response: { 200: CustomerDetailResponse, ...errors },
    },
  }, controller.detail);
};

export default routes;

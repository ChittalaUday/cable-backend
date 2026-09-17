import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { PERMISSIONS } from '@/security/permissions';
import {
  CustomerDetailResponse,
  CustomerPageResponse,
  IdParams,
  ListCustomersQuery,
} from './customer.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef };

  app.get('/customers', {
    config: { cache: { tag: 'customers' } },
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
  }, async (request) => {
    return request.server.customers.list(request.access, request.query);
  });

  app.get('/customers/:id', {
    config: { cache: { tag: 'customers' } },
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
  }, async (request) => {
    return request.server.customers.detail(request.access, request.params.id);
  });
};

export default routes;

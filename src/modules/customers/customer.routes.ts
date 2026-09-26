import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { PERMISSIONS } from '@/security/permissions';
import {
  AddSubscriptionBody,
  ChangePlanBody,
  CreateCustomerBody,
  CustomerDetailResponse,
  CustomerPageResponse,
  IdParams,
  ListCustomersQuery,
  SubscriptionIdParams,
  SubscriptionResponse,
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

  app.post('/customers', {
    config: { invalidates: ['analytics', 'customers', 'payments', 'inventory'] },
    preHandler: app.requirePermission(PERMISSIONS.CUSTOMERS_CREATE),
    schema: {
      tags: ['customers'],
      summary: 'Register a subscriber, optionally with their first connection',
      description: [
        'The subscriber code is minted by the database, not sent in: two collectors registering at two doors in the same minute must not be handed the same one. The first connection takes that code as its service account number, and later lines suffix off it (`SSCN-0042-A1`).',
        '',
        'The customer and the connection land in one transaction. A customer with no line is reachable only by a tenant-wide account, because every area-scoped screen finds customers through where their lines are fitted — so an area-scoped caller must send `connection`, and its `locationId` must sit inside the areas they cover.',
        '',
        'The response is the same shape as `GET /customers/:id`, so the client renders the new subscriber without a follow-up call.',
      ].join('\n'),
      body: CreateCustomerBody,
      response: { 201: CustomerDetailResponse, ...errors },
    },
  }, async (request, reply) => {
    const created = await request.server.customers.create(request.access, request.body);

    return reply.status(201).send(created);
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

  app.patch('/customers/:id/subscriptions/:subscriptionId', {
    config: { invalidates: ['analytics', 'customers', 'payments'] },
    preHandler: app.requirePermission(PERMISSIONS.CONNECTIONS_UPDATE),
    schema: {
      tags: ['customers'],
      summary: 'Move a connection onto a different package',
      description: [
        'The package must belong to the same provider as the line: crossing providers would orphan the service account number, which is a new connection rather than a plan change.',
        '',
        'Nothing is prorated. `outstanding_balance` is only ever written down by a payment — no job accrues the monthly fee — so there is no part-cycle to split. The new price is what the next charge will use.',
        '',
        '`price` overrides the package list price for this one customer. Omitted, the line takes the package price.',
      ].join('\n'),
      params: SubscriptionIdParams,
      body: ChangePlanBody,
      response: { 200: SubscriptionResponse, ...errors, 409: errorRef },
    },
  }, async (request) => {
    return request.server.customers.changePlan(
      request.access,
      request.params.id,
      request.params.subscriptionId,
      request.body,
    );
  });

  app.post('/customers/:id/subscriptions', {
    config: { invalidates: ['analytics', 'customers', 'payments'] },
    preHandler: app.requirePermission(PERMISSIONS.CONNECTIONS_CREATE),
    schema: {
      tags: ['customers'],
      summary: 'Add another package to a customer as its own line — an addon, or a second connection',
      description: [
        'An addon is a subscription of its own rather than a flag on an existing one, because that is the shape the data has: one package per line, one balance per line. It therefore bills, collects and appears on every screen that already reads lines.',
        '',
        '`basedOn` names the line it sits beside. The provider, installation location and address are inherited from it, so an addon cannot be created somewhere the base connection is not. The new line gets its own account number, suffixed off the base: `SSCN-0042-A1`.',
        '',
        'It starts at a zero balance. Money is taken through `POST /payments/subscription` against the new line like any other.',
      ].join('\n'),
      params: IdParams,
      body: AddSubscriptionBody,
      response: { 201: SubscriptionResponse, ...errors },
    },
  }, async (request, reply) => {
    const created = await request.server.customers.addSubscription(
      request.access,
      request.params.id,
      request.body,
    );

    return reply.status(201).send(created);
  });
};

export default routes;

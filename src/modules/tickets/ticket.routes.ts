import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { PERMISSIONS } from '@/security/permissions';
import { paginated } from '@/utils/pagination';
import {
  AssignTicketBody,
  CreateTicketBody,
  ListTicketsQuery,
  TicketIdParams,
  TicketResponse,
  UpdateTicketBody,
} from './ticket.schema';
import { TicketService } from './ticket.service';

declare module 'fastify' {
  interface FastifyInstance {
    tickets: TicketService;
  }
}

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('tickets', new TicketService(app.db));

  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef };

  // Deliberately uncached, reads and writes alike. A complaint queue turns over
  // faster than any cache generation, and the list joins the customer, the line
  // and the package — caching it would make a package rename or a payment drop
  // the ticket cache, which is a lot of invalidation to buy a stale queue.
  app.get('/tickets', {
    preHandler: app.requirePermission(PERMISSIONS.TICKETS_VIEW),
    schema: {
      tags: ['tickets'],
      summary: 'Complaints this caller may see',
      description: [
        'Scoped by the grant on `tickets.view`. At ALL it is the whole tenant; at LOCATION it is the areas the caller covers plus anything they raised or hold; at ASSIGNED or TEAM it is their own, their team\'s, and anything still unclaimed in their areas — an unassigned fault nobody can see is a fault nobody fixes; at OWN it is only what they raised or hold.',
        '',
        '`openOnly` folds together every status a ticket is still worked on in, which is what an operator means by "open".',
        '',
        '`assignedTo=me` resolves to the caller, so a handset does not need its own user id.',
      ].join('\n'),
      querystring: ListTicketsQuery,
      response: { 200: paginated(TicketResponse), ...errors },
    },
  }, async (request) => {
    return request.server.tickets.list(request.access, request.query);
  });

  app.get('/tickets/:id', {
    preHandler: app.requirePermission(PERMISSIONS.TICKETS_VIEW),
    schema: {
      tags: ['tickets'],
      summary: 'One complaint, with the customer and line it is about',
      description: 'Out of the caller\'s reach answers 404 rather than 403: whether a ticket exists elsewhere is not something the caller should learn.',
      params: TicketIdParams,
      response: { 200: TicketResponse, ...errors },
    },
  }, async (request) => {
    return request.server.tickets.detail(request.access, request.params.id);
  });

  app.post('/tickets', {
    preHandler: app.requirePermission(PERMISSIONS.TICKETS_CREATE),
    schema: {
      tags: ['tickets'],
      summary: 'Raise a complaint against a customer or one of their lines',
      description: [
        'The ticket number is minted by the database off the tenant\'s own counter — `SSCN-T-000042` — so it reads as a family with the subscriber code and two people raising one in the same second cannot collide.',
        '',
        'The area is copied from the named line, or from the customer\'s first line when none is named. That is what every area-scoped list filters on, so a customer with no connection at all produces a ticket only a tenant-wide account will see.',
        '',
        'Passing `assignedTo` needs `tickets.assign` as well.',
      ].join('\n'),
      body: CreateTicketBody,
      response: { 201: TicketResponse, ...errors },
    },
  }, async (request, reply) => {
    const created = await request.server.tickets.create(request.access, request.body);

    return reply.status(201).send(created);
  });

  app.patch('/tickets/:id', {
    preHandler: app.requirePermission(PERMISSIONS.TICKETS_UPDATE),
    schema: {
      tags: ['tickets'],
      summary: 'Change a complaint — its status, priority, category or notes',
      description: [
        'Moving one to `resolved`, `closed` or `cancelled` needs `tickets.resolve` on top of `tickets.update`: reprioritising is field work, but telling a subscriber their fault is fixed is not.',
        '',
        '`resolved` requires a resolution, because that text is what the customer is told. `resolvedAt` is stamped once, when the ticket first settles, and a later edit never moves it.',
      ].join('\n'),
      params: TicketIdParams,
      body: UpdateTicketBody,
      response: { 200: TicketResponse, ...errors },
    },
  }, async (request) => {
    return request.server.tickets.update(request.access, request.params.id, request.body);
  });

  app.post('/tickets/:id/assign', {
    preHandler: app.requirePermission(PERMISSIONS.TICKETS_ASSIGN),
    schema: {
      tags: ['tickets'],
      summary: 'Hand a complaint to somebody, or put it back in the pool',
      description: 'Assigning an `open` ticket also moves it to `in_progress` — handing it over is the moment it stops being a queue entry. `assignedTo: null` releases it.',
      params: TicketIdParams,
      body: AssignTicketBody,
      response: { 200: TicketResponse, ...errors },
    },
  }, async (request) => {
    return request.server.tickets.assign(request.access, request.params.id, request.body);
  });
};

export default routes;

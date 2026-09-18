import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { PERMISSIONS } from '@/security/permissions';
import { ERRORS } from '@/types/typebox';
import {
  CollectionIdParams,
  CollectionPage,
  CollectionResponse,
  ListCollectionsQuery,
  RecordCollectionBody,
  ReverseCollectionBody,
} from './payment.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.get('/payments', {
    config: { cache: { tag: 'payments' } },
    preHandler: app.requirePermission(PERMISSIONS.PAYMENTS_VIEW),
    schema: {
      tags: ['payments'],
      summary: 'Collections the caller may see — their own areas, their own round, or the whole tenant',
      description: 'The grant scope on `payments.view` decides the rows: `ALL` the tenant, `LOCATION` the granted areas, `OWN` the subscriber\'s own receipts.',
      querystring: ListCollectionsQuery,
      response: { 200: CollectionPage, ...ERRORS },
    },
  }, async (request) => {
    return request.server.payments.list(request.access, request.query);
  });

  app.get('/payments/:id', {
    config: { cache: { tag: 'payments' } },
    preHandler: app.requirePermission(PERMISSIONS.PAYMENTS_VIEW),
    schema: {
      tags: ['payments'],
      summary: 'One receipt',
      params: CollectionIdParams,
      response: { 200: CollectionResponse, ...ERRORS },
    },
  }, async (request) => {
    return request.server.payments.get(request.access, request.params.id);
  });

  app.post('/payments', {
    config: { invalidates: ['analytics', 'customers', 'payments'] },
    preHandler: app.requirePermission(PERMISSIONS.PAYMENTS_COLLECT),
    schema: {
      tags: ['payments'],
      summary: 'Record a doorstep visit: full payment, part payment, or nothing with a reason',
      description: 'Idempotent on `reference` — replaying one returns the original receipt rather than taking the money twice.',
      body: RecordCollectionBody,
      response: { 201: CollectionResponse, ...ERRORS },
    },
  }, async (request, reply) => {
    const receipt = await request.server.payments.record(request.access, request.body);
    return reply.status(201).send(receipt);
  });

  app.post('/payments/:id/reverse', {
    config: { invalidates: ['analytics', 'customers', 'payments'] },
    preHandler: app.requirePermission(PERMISSIONS.PAYMENTS_UPDATE),
    schema: {
      tags: ['payments'],
      summary: 'Post the mirror image of a receipt. The original row is never changed.',
      params: CollectionIdParams,
      body: ReverseCollectionBody,
      response: { 201: CollectionResponse, ...ERRORS },
    },
  }, async (request, reply) => {
    const reversal = await request.server.payments.reverse(request.access, request.params.id, request.body);
    return reply.status(201).send(reversal);
  });
};

export default routes;

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/security/permissions';
import {
  CreateProviderBody,
  IdParams,
  ListProvidersQuery,
  ProviderResponse,
  UpdateProviderBody,
} from '../service.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/service-providers', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'List providers, optionally for one service',
      querystring: ListProvidersQuery,
      response: { 200: Type.Array(ProviderResponse), ...errors },
    },
  }, async (request) => {
    return request.server.services.listProviders(request.access, request.query);
  });

  app.post('/service-providers', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_CREATE),
    schema: {
      tags: ['services'],
      summary: 'Add a supplier for a service',
      description: 'A second MSO on the same service is a row here — never a duplicate service.',
      body: CreateProviderBody,
      response: { 201: ProviderResponse, ...errors },
    },
  }, async (request, reply) => {
    const provider = await request.server.services.createProvider(request.access, request.body);
    return reply.status(201).header('location', `${request.url}/${provider.id}`).send(provider);
  });

  app.get('/service-providers/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'Read one provider',
      params: IdParams,
      response: { 200: ProviderResponse, ...errors },
    },
  }, async (request) => {
    return request.server.services.getProvider(request.access, request.params.id);
  });

  app.patch('/service-providers/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_UPDATE),
    schema: {
      tags: ['services'],
      summary: 'Edit a provider, or make it the default for its service',
      description: '`serviceId` is fixed — moving a provider would take its packages and every subscription with it.',
      params: IdParams,
      body: UpdateProviderBody,
      response: { 200: ProviderResponse, ...errors },
    },
  }, async (request) => {
    return request.server.services.updateProvider(request.access, request.params.id, request.body);
  });

  app.delete('/service-providers/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_DELETE),
    schema: {
      tags: ['services'],
      summary: 'Delete a provider that has no packages and no subscriptions',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, async (request, reply) => {
    await request.server.services.removeProvider(request.access, request.params.id);
    return reply.status(204).send(null);
  });
};

export default routes;

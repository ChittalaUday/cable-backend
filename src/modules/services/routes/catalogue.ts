import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/security/permissions';
import {
  CreateServiceBody,
  IdParams,
  ListServicesQuery,
  ServiceResponse,
  UpdateServiceBody,
} from '../service.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/services', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'List services, each with how many active providers deliver it',
      querystring: ListServicesQuery,
      response: { 200: Type.Array(ServiceResponse), ...errors },
    },
  }, async (request) => {
    return request.server.services.list(request.access, request.query);
  });

  app.post('/services', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_CREATE),
    schema: {
      tags: ['services'],
      summary: 'Add a service',
      description: 'Name it for what it is — `Cable TV`, not `ACT Cable TV`. The brand belongs to a provider.',
      body: CreateServiceBody,
      response: { 201: ServiceResponse, ...errors },
    },
  }, async (request, reply) => {
    const service = await request.server.services.create(request.access, request.body);
    return reply.status(201).header('location', `${request.url}/${service.id}`).send(service);
  });

  app.get('/services/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'Read one service',
      params: IdParams,
      response: { 200: ServiceResponse, ...errors },
    },
  }, async (request) => {
    return request.server.services.get(request.access, request.params.id);
  });

  app.patch('/services/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_UPDATE),
    schema: {
      tags: ['services'],
      summary: 'Rename or deactivate a service',
      description: '`slug` is fixed: it is referenced by what already sells.',
      params: IdParams,
      body: UpdateServiceBody,
      response: { 200: ServiceResponse, ...errors },
    },
  }, async (request) => {
    return request.server.services.update(request.access, request.params.id, request.body);
  });

  app.delete('/services/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_DELETE),
    schema: {
      tags: ['services'],
      summary: 'Delete a service that has no providers',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, async (request, reply) => {
    await request.server.services.remove(request.access, request.params.id);
    return reply.status(204).send(null);
  });
};

export default routes;

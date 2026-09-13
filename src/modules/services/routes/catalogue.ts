import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from '../services.controller';
import {
  CreateServiceBody,
  IdParams,
  ListServicesQuery,
  ServiceResponse,
  UpdateServiceBody,
} from '../services.schema';

/**
 * What a tenant sells (docs/services-providers-packages.md).
 *
 * A service is the thing a subscriber buys — Cable TV, Broadband. Who supplies
 * it is a provider, and that is the next file.
 */
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
  }, controller.list);

  app.post('/services', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_CREATE),
    schema: {
      tags: ['services'],
      summary: 'Add a service',
      description: 'Name it for what it is — `Cable TV`, not `ACT Cable TV`. The brand belongs to a provider.',
      body: CreateServiceBody,
      response: { 201: ServiceResponse, ...errors },
    },
  }, controller.create);

  app.get('/services/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'Read one service',
      params: IdParams,
      response: { 200: ServiceResponse, ...errors },
    },
  }, controller.get);

  app.patch('/services/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_UPDATE),
    schema: {
      tags: ['services'],
      summary: 'Rename or deactivate a service',
      description: '`slug` and `serviceType` are fixed: both are referenced by what already sells.',
      params: IdParams,
      body: UpdateServiceBody,
      response: { 200: ServiceResponse, ...errors },
    },
  }, controller.update);

  app.delete('/services/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_DELETE),
    schema: {
      tags: ['services'],
      summary: 'Retire a service that has no providers left',
      description: 'Soft delete — a three-year-old subscription still names what it was for (§8).',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, controller.remove);
};

export default routes;

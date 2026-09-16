import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from '../services.controller';
import {
  CreateProviderBody,
  IdParams,
  ListProvidersQuery,
  ProviderResponse,
  UpdateProviderBody,
} from '../services.schema';

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
  }, controller.listProviders);

  app.post('/service-providers', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_CREATE),
    schema: {
      tags: ['services'],
      summary: 'Add a supplier for a service',
      description: 'A second MSO on the same service is a row here — never a duplicate service.',
      body: CreateProviderBody,
      response: { 201: ProviderResponse, ...errors },
    },
  }, controller.createProvider);

  app.get('/service-providers/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'Read one provider',
      params: IdParams,
      response: { 200: ProviderResponse, ...errors },
    },
  }, controller.getProvider);

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
  }, controller.updateProvider);

  app.delete('/service-providers/:id', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_DELETE),
    schema: {
      tags: ['services'],
      summary: 'Retire a provider',
      description: 'Soft delete, so its packages and their subscriptions keep explaining themselves.',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, controller.removeProvider);
};

export default routes;

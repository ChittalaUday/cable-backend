import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/security/permissions';
import {
  AvailabilityResponse,
  CoverageResponse,
  IdParams,
  SetCoverageBody,
} from '../service.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };
  const coverageList = Type.Array(CoverageResponse);

  app.get('/service-providers/:id/coverage', {
    config: { cache: { tag: 'coverage' } },
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'Where this provider is sold',
      params: IdParams,
      response: { 200: coverageList, ...errors },
    },
  }, async (request) => {
    return request.server.coverage.listForProvider(request.access, request.params.id);
  });

  app.put('/service-providers/:id/coverage', {
    config: { invalidates: ['channels', 'coverage', 'locations', 'packages', 'service-providers', 'services'] },
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_UPDATE),
    schema: {
      tags: ['services'],
      summary: 'Replace this provider’s coverage',
      description: 'Sent as a whole list. `isAvailable: false` on a deeper node is how a hole in a covered area is expressed.',
      params: IdParams,
      body: SetCoverageBody,
      response: { 200: coverageList, ...errors },
    },
  }, async (request) => {
    return request.server.coverage.replaceForProvider(request.access, request.params.id, request.body);
  });

  app.get('/packages/:id/coverage', {
    config: { cache: { tag: 'coverage' } },
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'Where this one package is sold, when that is narrower than its provider',
      description: 'Empty is the normal case: the package goes wherever its provider does.',
      params: IdParams,
      response: { 200: coverageList, ...errors },
    },
  }, async (request) => {
    return request.server.coverage.listForPackage(request.access, request.params.id);
  });

  app.put('/packages/:id/coverage', {
    config: { invalidates: ['channels', 'coverage', 'locations', 'packages', 'service-providers', 'services'] },
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_UPDATE),
    schema: {
      tags: ['services'],
      summary: 'Replace this package’s own coverage',
      description: 'The narrowest level there is — it beats the provider and the service row at this node. `[]` hands the package back to its provider’s reach.',
      params: IdParams,
      body: SetCoverageBody,
      response: { 200: coverageList, ...errors },
    },
  }, async (request) => {
    return request.server.coverage.replaceForPackage(request.access, request.params.id, request.body);
  });

  app.get('/services/:id/coverage', {
    config: { cache: { tag: 'coverage' } },
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'Fallback coverage for the whole service',
      description: 'Used when neither a provider nor a package has a row at this location. Providers usually declare their own.',
      params: IdParams,
      response: { 200: coverageList, ...errors },
    },
  }, async (request) => {
    return request.server.coverage.listForService(request.access, request.params.id);
  });

  app.put('/services/:id/coverage', {
    config: { invalidates: ['channels', 'coverage', 'locations', 'packages', 'service-providers', 'services'] },
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_UPDATE),
    schema: {
      tags: ['services'],
      summary: 'Replace fallback coverage for the whole service',
      params: IdParams,
      body: SetCoverageBody,
      response: { 200: coverageList, ...errors },
    },
  }, async (request) => {
    return request.server.coverage.replaceForService(request.access, request.params.id, request.body);
  });

  app.get('/locations/:id/available-services', {
    config: { cache: { tag: 'coverage' } },
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'The catalogue as a customer at this address sees it',
      description: 'Resolves inheritance up the tree: a provider declared on the building, the street, or the city is visible here unless an `isAvailable: false` on an ancestor turned it off.',
      params: IdParams,
      response: { 200: AvailabilityResponse, ...errors },
    },
  }, async (request) => {
    return request.server.coverage.availabilityAt(request.access, request.params.id);
  });
};

export default routes;

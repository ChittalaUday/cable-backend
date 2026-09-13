import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from '../services.controller';
import {
  AvailabilityResponse,
  CoverageResponse,
  IdParams,
  SetCoverageBody,
} from '../services.schema';

/**
 * Where each service and provider is sold (docs/services-providers-packages.md §5).
 *
 * A coverage row covers its node and everything below it, and the nearest
 * ancestor wins — so "ACT serves Mandapeta, except Block C" is two rows.
 */
const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };
  const coverageList = Type.Array(CoverageResponse);

  app.get('/service-providers/:id/coverage', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'Where this provider is sold',
      params: IdParams,
      response: { 200: coverageList, ...errors },
    },
  }, controller.listProviderCoverage);

  app.put('/service-providers/:id/coverage', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_UPDATE),
    schema: {
      tags: ['services'],
      summary: 'Replace this provider’s coverage',
      description: 'Sent as a whole list. `isAvailable: false` on a deeper node is how a hole in a covered area is expressed.',
      params: IdParams,
      body: SetCoverageBody,
      response: { 200: coverageList, ...errors },
    },
  }, controller.setProviderCoverage);

  app.get('/services/:id/coverage', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'Where this service is sold, whoever supplies it',
      params: IdParams,
      response: { 200: coverageList, ...errors },
    },
  }, controller.listServiceCoverage);

  app.put('/services/:id/coverage', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_UPDATE),
    schema: {
      tags: ['services'],
      summary: 'Replace the service-wide coverage',
      description: 'A provider row beats a service row at the same depth; both lose to a deeper row.',
      params: IdParams,
      body: SetCoverageBody,
      response: { 200: coverageList, ...errors },
    },
  }, controller.setServiceCoverage);

  app.get('/locations/:id/availability', {
    preHandler: app.requirePermission(PERMISSIONS.SERVICES_VIEW),
    schema: {
      tags: ['services'],
      summary: 'What a customer at this location can be sold',
      description: 'Services, their providers that reach here, and each provider’s active packages — one call for the add-customer wizard.',
      params: IdParams,
      response: { 200: AvailabilityResponse, ...errors },
    },
  }, controller.availability);
};

export default routes;

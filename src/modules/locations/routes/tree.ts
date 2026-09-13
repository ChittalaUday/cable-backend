import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { paginated } from '@/shared/pagination';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from '../locations.controller';
import {
  CreateLocationBody,
  IdParams,
  ListLocationsQuery,
  LocationResponse,
  UpdateLocationBody,
} from '../locations.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/locations', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_VIEW),
    schema: {
      tags: ['locations'],
      summary: 'List locations',
      description: '`parentId` lists children (`null` for roots), `ancestorId` lists a whole subtree, `q` matches name or alias.',
      querystring: ListLocationsQuery,
      response: { 200: paginated(LocationResponse), ...errors },
    },
  }, controller.list);

  app.post('/locations', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CREATE),
    schema: {
      tags: ['locations'],
      summary: 'Add a node — the flat the tree was missing',
      description: 'The category comes from the schema’s next level, not from the caller.',
      body: CreateLocationBody,
      response: { 201: LocationResponse, ...errors },
    },
  }, controller.create);

  app.get('/locations/:id', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_VIEW),
    schema: {
      tags: ['locations'],
      summary: 'Read one node, with its breadcrumb resolved',
      params: IdParams,
      response: { 200: LocationResponse, ...errors },
    },
  }, controller.get);

  app.patch('/locations/:id', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_UPDATE),
    schema: {
      tags: ['locations'],
      summary: 'Correct a node, or approve one an operator added',
      params: IdParams,
      body: UpdateLocationBody,
      response: { 200: LocationResponse, ...errors },
    },
  }, controller.update);

  app.delete('/locations/:id', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_DELETE),
    schema: {
      tags: ['locations'],
      summary: 'Delete a leaf node',
      description: 'A node with children, or customers on it, is a 409 (§8.6).',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, controller.remove);
};

export default routes;

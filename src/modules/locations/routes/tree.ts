import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/security/permissions';
import { paginated } from '@/utils/pagination';
import {
  AncestorResponse,
  CreateLocationBody,
  IdParams,
  ListLocationsQuery,
  LocationResponse,
  UpdateLocationBody,
} from '../location.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/locations', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_VIEW),
    schema: {
      tags: ['locations'],
      summary: 'List locations',
      description: '`parentId` lists children (`null` for roots), `ancestorId` lists a whole subtree, `q` matches name or alias. `coverageServiceId` (plus `coverageProviderId` to narrow) returns only the nodes that level of the catalogue may be sold in — what a coverage picker offers.',
      querystring: ListLocationsQuery,
      response: { 200: paginated(LocationResponse), ...errors },
    },
  }, async (request) => {
    return request.server.locations.list(request.access, request.query);
  });

  app.post('/locations', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CREATE),
    schema: {
      tags: ['locations'],
      summary: 'Add a node — the flat the tree was missing',
      description: 'The category comes from the schema’s next level, not from the caller.',
      body: CreateLocationBody,
      response: { 201: LocationResponse, ...errors },
    },
  }, async (request, reply) => {
    const location = await request.server.locations.create(request.access, request.body);
    return reply.status(201).header('location', `${request.url}/${location.id}`).send(location);
  });

  app.get('/locations/:id', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_VIEW),
    schema: {
      tags: ['locations'],
      summary: 'Read one node, with its breadcrumb resolved',
      params: IdParams,
      response: { 200: LocationResponse, ...errors },
    },
  }, async (request) => {
    return request.server.locations.get(request.access, request.params.id);
  });

  app.get('/locations/:id/ancestors', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_VIEW),
    schema: {
      tags: ['locations'],
      summary: 'The chain from the root down to this node, for revealing it in a tree',
      description: 'Root first, the node itself last. `siblingIndex` says which page of its own level each step is on, so a deep node can be opened without walking pages.',
      params: IdParams,
      response: { 200: Type.Array(AncestorResponse), ...errors },
    },
  }, async (request) => {
    return request.server.locations.ancestorsOf(request.access, request.params.id);
  });

  app.patch('/locations/:id', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_UPDATE),
    schema: {
      tags: ['locations'],
      summary: 'Correct a node, or approve one an operator added',
      params: IdParams,
      body: UpdateLocationBody,
      response: { 200: LocationResponse, ...errors },
    },
  }, async (request) => {
    return request.server.locations.update(request.access, request.params.id, request.body);
  });

  app.delete('/locations/:id', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_DELETE),
    schema: {
      tags: ['locations'],
      summary: 'Delete a leaf node',
      description: 'A node with children, or customers on it, is a 409 (§8.6).',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, async (request, reply) => {
    await request.server.locations.remove(request.access, request.params.id);
    return reply.status(204).send(null);
  });
};

export default routes;

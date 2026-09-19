import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/security/permissions';
import {
  CategoryResponse,
  CreateCategoryBody,
  CreateSchemaBody,
  GenerateBody,
  GenerateResponse,
  IdParams,
  SchemaResponse,
  UpdateCategoryBody,
  UpdateSchemaBody,
} from '../location.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/location-categories', {
    config: { cache: { tag: 'location-config', scope: 'tenant' } },
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_VIEW),
    schema: {
      tags: ['locations'],
      summary: 'List the tenant’s location categories',
      response: { 200: Type.Array(CategoryResponse), ...errors },
    },
  }, async (request) => {
    return request.server.locations.listCategories(request.access);
  });

  app.post('/location-categories', {
    config: { invalidates: ['location-config'] },
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Define a location category',
      body: CreateCategoryBody,
      response: { 201: CategoryResponse, ...errors },
    },
  }, async (request, reply) => {
    const category = await request.server.locations.createCategory(request.access, request.body);
    return reply.status(201).header('location', `${request.url}/${category.id}`).send(category);
  });

  app.patch('/location-categories/:id', {
    config: { invalidates: ['location-config'] },
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Rename a category or change its display rules',
      params: IdParams,
      body: UpdateCategoryBody,
      response: { 200: CategoryResponse, ...errors },
    },
  }, async (request) => {
    return request.server.locations.updateCategory(request.access, request.params.id, request.body);
  });

  app.delete('/location-categories/:id', {
    config: { invalidates: ['location-config'] },
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Delete a category — a 409 while a schema level or a location still uses it',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, async (request, reply) => {
    await request.server.locations.deleteCategory(request.access, request.params.id);
    return reply.status(204).send(null);
  });

  app.get('/location-schemas', {
    config: { cache: { tag: 'location-config', scope: 'tenant' } },
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_VIEW),
    schema: {
      tags: ['locations'],
      summary: 'List hierarchy shapes with their ordered levels — a tenant runs several at once',
      response: { 200: Type.Array(SchemaResponse), ...errors },
    },
  }, async (request) => {
    return request.server.locations.listSchemas(request.access);
  });

  app.post('/location-schemas', {
    config: { invalidates: ['location-config'] },
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Define a hierarchy: levels root-first',
      body: CreateSchemaBody,
      response: { 201: SchemaResponse, ...errors },
    },
  }, async (request, reply) => {
    const created = await request.server.locations.createSchema(request.access, request.body);
    return reply.status(201).header('location', `${request.url}/${created.id}`).send(created);
  });

  app.patch('/location-schemas/:id', {
    config: { invalidates: ['location-config'] },
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Rename or deactivate a hierarchy. Levels are not edited in place — nodes reference them',
      params: IdParams,
      body: UpdateSchemaBody,
      response: { 200: SchemaResponse, ...errors },
    },
  }, async (request) => {
    return request.server.locations.updateSchema(request.access, request.params.id, request.body);
  });

  app.delete('/location-schemas/:id', {
    config: { invalidates: ['location-config'] },
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Delete a hierarchy that has no locations',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, async (request, reply) => {
    await request.server.locations.deleteSchema(request.access, request.params.id);
    return reply.status(204).send(null);
  });

  app.post('/location-schemas/:id/generate', {
    config: { invalidates: ['analytics', 'channels', 'coverage', 'customers', 'inventory', 'locations', 'packages', 'payments', 'service-providers', 'services', 'staff', 'teams'] },
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Bulk-create a subtree from this hierarchy',
      description: 'Blocks A–C, floors Ground–3, four doors each: 60 ordinary location rows, not a JSON blob.',
      params: IdParams,
      body: GenerateBody,
      response: { 201: GenerateResponse, ...errors },
    },
  }, async (request, reply) => {
    const result = await request.server.locations.generate(request.access, request.params.id, request.body);
    return reply.status(201).send(result);
  });
};

export default routes;

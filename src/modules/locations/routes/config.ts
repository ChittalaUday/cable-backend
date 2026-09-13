import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from '../locations.controller';
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
} from '../locations.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/location-categories', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_VIEW),
    schema: {
      tags: ['locations'],
      summary: 'List the tenant’s location categories',
      response: { 200: Type.Array(CategoryResponse), ...errors },
    },
  }, controller.listCategories);

  app.post('/location-categories', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Define a location category',
      body: CreateCategoryBody,
      response: { 201: CategoryResponse, ...errors },
    },
  }, controller.createCategory);

  app.patch('/location-categories/:id', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Rename a category or change its display rules',
      params: IdParams,
      body: UpdateCategoryBody,
      response: { 200: CategoryResponse, ...errors },
    },
  }, controller.updateCategory);

  app.delete('/location-categories/:id', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Delete a category — a 409 while a schema level or a location still uses it',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, controller.deleteCategory);

  app.get('/location-schemas', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_VIEW),
    schema: {
      tags: ['locations'],
      summary: 'List hierarchy shapes with their ordered levels — a tenant runs several at once',
      response: { 200: Type.Array(SchemaResponse), ...errors },
    },
  }, controller.listSchemas);

  app.post('/location-schemas', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Define a hierarchy: levels root-first',
      body: CreateSchemaBody,
      response: { 201: SchemaResponse, ...errors },
    },
  }, controller.createSchema);

  app.patch('/location-schemas/:id', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Rename or deactivate a hierarchy. Levels are not edited in place — nodes reference them',
      params: IdParams,
      body: UpdateSchemaBody,
      response: { 200: SchemaResponse, ...errors },
    },
  }, controller.updateSchema);

  app.delete('/location-schemas/:id', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Delete a hierarchy that has no locations',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, controller.deleteSchema);

  app.post('/location-schemas/:id/generate', {
    preHandler: app.requirePermission(PERMISSIONS.LOCATIONS_CONFIGURE),
    schema: {
      tags: ['locations'],
      summary: 'Bulk-create a subtree from this hierarchy',
      description: 'Blocks A–C, floors Ground–3, four doors each: 60 ordinary location rows, not a JSON blob.',
      params: IdParams,
      body: GenerateBody,
      response: { 201: GenerateResponse, ...errors },
    },
  }, controller.generate);
};

export default routes;

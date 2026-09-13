import type { FastifyReply } from 'fastify';
import type {
  CreateCategoryBody,
  CreateLocationBody,
  CreateSchemaBody,
  GenerateBody,
  IdParams,
  ListLocationsQuery,
  UpdateCategoryBody,
  UpdateLocationBody,
  UpdateSchemaBody,
} from './locations.schema';
import type { Req } from '@/shared/types/request';

export async function listCategories(request: Req) {
  return request.server.locations.listCategories(request.access);
}

export async function createCategory(
  request: Req<{ body: typeof CreateCategoryBody }>,
  reply: FastifyReply,
) {
  const category = await request.server.locations.createCategory(request.access, request.body);

  return reply.status(201).header('location', `${request.url}/${category.id}`).send(category);
}

export async function updateCategory(request: Req<{ params: typeof IdParams; body: typeof UpdateCategoryBody }>) {
  return request.server.locations.updateCategory(request.access, request.params.id, request.body);
}

export async function deleteCategory(request: Req<{ params: typeof IdParams }>, reply: FastifyReply) {
  await request.server.locations.deleteCategory(request.access, request.params.id);

  return reply.status(204).send();
}

export async function listSchemas(request: Req) {
  return request.server.locations.listSchemas(request.access);
}

export async function createSchema(
  request: Req<{ body: typeof CreateSchemaBody }>,
  reply: FastifyReply,
) {
  const created = await request.server.locations.createSchema(request.access, request.body);

  return reply.status(201).header('location', `${request.url}/${created.id}`).send(created);
}

export async function updateSchema(request: Req<{ params: typeof IdParams; body: typeof UpdateSchemaBody }>) {
  return request.server.locations.updateSchema(request.access, request.params.id, request.body);
}

export async function deleteSchema(request: Req<{ params: typeof IdParams }>, reply: FastifyReply) {
  await request.server.locations.deleteSchema(request.access, request.params.id);

  return reply.status(204).send();
}

export async function generate(
  request: Req<{ params: typeof IdParams; body: typeof GenerateBody }>,
  reply: FastifyReply,
) {
  const result = await request.server.locations.generate(request.access, request.params.id, request.body);

  return reply.status(201).send(result);
}

export async function list(request: Req<{ querystring: typeof ListLocationsQuery }>) {
  return request.server.locations.list(request.access, request.query);
}

export async function get(request: Req<{ params: typeof IdParams }>) {
  return request.server.locations.get(request.access, request.params.id);
}

export async function create(
  request: Req<{ body: typeof CreateLocationBody }>,
  reply: FastifyReply,
) {
  const location = await request.server.locations.create(request.access, request.body);

  return reply.status(201).header('location', `${request.url}/${location.id}`).send(location);
}

export async function update(request: Req<{ params: typeof IdParams; body: typeof UpdateLocationBody }>) {
  return request.server.locations.update(request.access, request.params.id, request.body);
}

export async function remove(request: Req<{ params: typeof IdParams }>, reply: FastifyReply) {
  await request.server.locations.remove(request.access, request.params.id);

  return reply.status(204).send();
}

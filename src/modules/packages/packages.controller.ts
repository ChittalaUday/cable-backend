import type { FastifyReply } from 'fastify';
import type {
  CreatePackageBody,
  IdParams,
  ListChannelsQuery,
  ListPackagesQuery,
  SetPackageChannelsBody,
  UpdatePackageBody,
} from './packages.schema';
import type { Req } from '@/shared/types/request';

export async function list(request: Req<{ querystring: typeof ListPackagesQuery }>) {
  return request.server.packages.list(request.access, request.query);
}

export async function get(request: Req<{ params: typeof IdParams }>) {
  return request.server.packages.get(request.access, request.params.id);
}

export async function create(request: Req<{ body: typeof CreatePackageBody }>, reply: FastifyReply) {
  const created = await request.server.packages.create(request.access, request.body);

  return reply.status(201).header('location', `${request.url}/${created.id}`).send(created);
}

export async function update(request: Req<{ params: typeof IdParams; body: typeof UpdatePackageBody }>) {
  return request.server.packages.update(request.access, request.params.id, request.body);
}

export async function remove(request: Req<{ params: typeof IdParams }>, reply: FastifyReply) {
  await request.server.packages.remove(request.access, request.params.id);

  return reply.status(204).send();
}

export async function setChannels(request: Req<{ params: typeof IdParams; body: typeof SetPackageChannelsBody }>) {
  return request.server.packages.setChannels(request.access, request.params.id, request.body);
}

export async function listChannels(request: Req<{ querystring: typeof ListChannelsQuery }>) {
  return request.server.packages.listChannels(request.access, request.query);
}

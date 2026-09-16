import type { FastifyReply } from 'fastify';
import type { CreateRemoteBody, IdParams, ListRemotesQuery } from './remotes.schema';
import type { Req } from '@/shared/types/request';

export async function list(request: Req<{ querystring: typeof ListRemotesQuery }>) {
  return request.server.remotes.list(request.access, request.query);
}

export async function get(request: Req<{ params: typeof IdParams }>) {
  return request.server.remotes.get(request.access, request.params.id);
}

export async function create(request: Req<{ body: typeof CreateRemoteBody }>, reply: FastifyReply) {
  const remote = await request.server.remotes.create(request.access, request.body);
  return reply.status(201).send(remote);
}

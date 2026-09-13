import type { FastifyReply } from 'fastify';
import type {
  CreateProviderBody,
  CreateServiceBody,
  IdParams,
  ListProvidersQuery,
  ListServicesQuery,
  SetCoverageBody,
  UpdateProviderBody,
  UpdateServiceBody,
} from './services.schema';
import type { Req } from '@/shared/types/request';

/**
 * The only layer that touches `request`/`reply` (AGENTS.md §3).
 */

export async function list(request: Req<{ querystring: typeof ListServicesQuery }>) {
  return request.server.services.list(request.access, request.query);
}

export async function get(request: Req<{ params: typeof IdParams }>) {
  return request.server.services.get(request.access, request.params.id);
}

export async function create(request: Req<{ body: typeof CreateServiceBody }>, reply: FastifyReply) {
  const service = await request.server.services.create(request.access, request.body);

  return reply.status(201).header('location', `${request.url}/${service.id}`).send(service);
}

export async function update(request: Req<{ params: typeof IdParams; body: typeof UpdateServiceBody }>) {
  return request.server.services.update(request.access, request.params.id, request.body);
}

export async function remove(request: Req<{ params: typeof IdParams }>, reply: FastifyReply) {
  await request.server.services.remove(request.access, request.params.id);

  return reply.status(204).send();
}

export async function listProviders(request: Req<{ querystring: typeof ListProvidersQuery }>) {
  return request.server.services.listProviders(request.access, request.query);
}

export async function getProvider(request: Req<{ params: typeof IdParams }>) {
  return request.server.services.getProvider(request.access, request.params.id);
}

export async function createProvider(request: Req<{ body: typeof CreateProviderBody }>, reply: FastifyReply) {
  const provider = await request.server.services.createProvider(request.access, request.body);

  return reply.status(201).header('location', `${request.url}/${provider.id}`).send(provider);
}

export async function updateProvider(request: Req<{ params: typeof IdParams; body: typeof UpdateProviderBody }>) {
  return request.server.services.updateProvider(request.access, request.params.id, request.body);
}

export async function removeProvider(request: Req<{ params: typeof IdParams }>, reply: FastifyReply) {
  await request.server.services.removeProvider(request.access, request.params.id);

  return reply.status(204).send();
}

export async function listProviderCoverage(request: Req<{ params: typeof IdParams }>) {
  return request.server.coverage.listForProvider(request.access, request.params.id);
}

export async function setProviderCoverage(request: Req<{ params: typeof IdParams; body: typeof SetCoverageBody }>) {
  return request.server.coverage.replaceForProvider(request.access, request.params.id, request.body);
}

export async function listServiceCoverage(request: Req<{ params: typeof IdParams }>) {
  return request.server.coverage.listForService(request.access, request.params.id);
}

export async function setServiceCoverage(request: Req<{ params: typeof IdParams; body: typeof SetCoverageBody }>) {
  return request.server.coverage.replaceForService(request.access, request.params.id, request.body);
}

export async function availability(request: Req<{ params: typeof IdParams }>) {
  return request.server.coverage.availabilityAt(request.access, request.params.id);
}

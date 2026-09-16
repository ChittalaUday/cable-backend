import type { FastifyRequest } from 'fastify';

export async function authHook(request: FastifyRequest): Promise<void> {
  await request.server.authenticate(request);
}

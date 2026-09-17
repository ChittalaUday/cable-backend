import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/security/permissions';
import {
  CreateRemoteBody,
  IdParams,
  ListRemotesQuery,
  RemoteDetail,
  RemoteSummary,
} from './remote.schema';
import { RemotesService } from './remote.service';

declare module 'fastify' {
  interface FastifyInstance {
    remotes: RemotesService;
  }
}

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('remotes', new RemotesService(app.db));

  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/remotes', {
    config: { cache: { tag: 'remotes', scope: 'tenant' } },
    preHandler: app.requirePermission(PERMISSIONS.REMOTES_VIEW),
    schema: {
      tags: ['remotes'],
      summary: 'List IR remotes — the shared library plus this tenant\'s own captures',
      description: 'Filter by `deviceType` to browse televisions or set-top boxes separately. Button code sets are omitted; fetch one remote to get them.',
      querystring: ListRemotesQuery,
      response: { 200: Type.Array(RemoteSummary), ...errors },
    },
  }, async (request) => {
    return request.server.remotes.list(request.access, request.query);
  });

  app.get('/remotes/:id', {
    config: { cache: { tag: 'remotes', scope: 'tenant' } },
    preHandler: app.requirePermission(PERMISSIONS.REMOTES_VIEW),
    schema: {
      tags: ['remotes'],
      summary: 'Get one remote with its full button code set',
      description: 'Each button carries an IR command in exactly the shape the app\'s emitter transmits.',
      params: IdParams,
      response: { 200: RemoteDetail, ...errors },
    },
  }, async (request) => {
    return request.server.remotes.get(request.access, request.params.id);
  });

  app.post('/remotes', {
    config: { invalidates: ['remotes'] },
    preHandler: app.requirePermission(PERMISSIONS.REMOTES_MANAGE),
    schema: {
      tags: ['remotes'],
      summary: 'File a remote captured from a real handset',
      description: 'Stored against this tenant as a `learned` remote. The seeded library is read-only over the API.',
      body: CreateRemoteBody,
      response: { 201: RemoteDetail, ...errors },
    },
  }, async (request, reply) => {
    const remote = await request.server.remotes.create(request.access, request.body);
    return reply.status(201).send(remote);
  });
};

export default routes;

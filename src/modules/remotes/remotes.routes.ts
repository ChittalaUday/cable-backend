import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from './remotes.controller';
import {
  CreateRemoteBody,
  IdParams,
  ListRemotesQuery,
  RemoteDetail,
  RemoteSummary,
} from './remotes.schema';
import { RemotesService } from './remotes.service';

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
    preHandler: app.requirePermission(PERMISSIONS.REMOTES_VIEW),
    schema: {
      tags: ['remotes'],
      summary: 'List IR remotes — the shared library plus this tenant\'s own captures',
      description: 'Filter by `deviceType` to browse televisions or set-top boxes separately. Button code sets are omitted; fetch one remote to get them.',
      querystring: ListRemotesQuery,
      response: { 200: Type.Array(RemoteSummary), ...errors },
    },
  }, controller.list);

  app.get('/remotes/:id', {
    preHandler: app.requirePermission(PERMISSIONS.REMOTES_VIEW),
    schema: {
      tags: ['remotes'],
      summary: 'Get one remote with its full button code set',
      description: 'Each button carries an IR command in exactly the shape the app\'s emitter transmits.',
      params: IdParams,
      response: { 200: RemoteDetail, ...errors },
    },
  }, controller.get);

  app.post('/remotes', {
    preHandler: app.requirePermission(PERMISSIONS.REMOTES_MANAGE),
    schema: {
      tags: ['remotes'],
      summary: 'File a remote captured from a real handset',
      description: 'Stored against this tenant as a `learned` remote. The seeded library is read-only over the API.',
      body: CreateRemoteBody,
      response: { 201: RemoteDetail, ...errors },
    },
  }, controller.create);
};

export default routes;

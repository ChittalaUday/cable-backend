import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/security/permissions';
import { paginated } from '@/utils/pagination';
import {
  ChannelResponse,
  CreatePackageBody,
  IdParams,
  ListChannelsQuery,
  ListPackagesQuery,
  PackageDetailResponse,
  PackageResponse,
  SetPackageChannelsBody,
  UpdatePackageBody,
} from './package.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/packages', {
    config: { cache: { tag: 'packages' } },
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_VIEW),
    schema: {
      tags: ['packages'],
      summary: 'List packages',
      querystring: ListPackagesQuery,
      response: { 200: paginated(PackageResponse), ...errors },
    },
  }, async (request) => {
    return request.server.packages.list(request.access, request.query);
  });

  app.post('/packages', {
    config: { invalidates: ['coverage', 'customers', 'packages', 'service-providers', 'services'] },
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_CREATE),
    schema: {
      tags: ['packages'],
      summary: 'Add a package to a provider',
      description: 'Money is sent as a decimal string — never a JSON number (§8).',
      body: CreatePackageBody,
      response: { 201: PackageResponse, ...errors },
    },
  }, async (request, reply) => {
    const created = await request.server.packages.create(request.access, request.body);
    return reply.status(201).header('location', `${request.url}/${created.id}`).send(created);
  });

  app.get('/packages/:id', {
    config: { cache: { tag: 'packages' } },
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_VIEW),
    schema: {
      tags: ['packages'],
      summary: 'Read one package with its channel lineup',
      params: IdParams,
      response: { 200: PackageDetailResponse, ...errors },
    },
  }, async (request) => {
    return request.server.packages.get(request.access, request.params.id);
  });

  app.patch('/packages/:id', {
    config: { invalidates: ['coverage', 'customers', 'packages', 'service-providers', 'services'] },
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_UPDATE),
    schema: {
      tags: ['packages'],
      summary: 'Reprice or edit a package',
      params: IdParams,
      body: UpdatePackageBody,
      response: { 200: PackageResponse, ...errors },
    },
  }, async (request) => {
    return request.server.packages.update(request.access, request.params.id, request.body);
  });

  app.delete('/packages/:id', {
    config: { invalidates: ['channels', 'coverage', 'customers', 'locations', 'packages', 'service-providers', 'services'] },
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_DELETE),
    schema: {
      tags: ['packages'],
      summary: 'Delete a package that has no subscriptions',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, async (request, reply) => {
    await request.server.packages.remove(request.access, request.params.id);
    return reply.status(204).send(null);
  });

  app.put('/packages/:id/channels', {
    config: { invalidates: ['channels', 'customers', 'packages'] },
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_UPDATE),
    schema: {
      tags: ['packages'],
      summary: 'Set the channel lineup for a package',
      description: 'Replaces the entire lineup: omitted channels are removed, new ones added.',
      params: IdParams,
      body: SetPackageChannelsBody,
      response: { 200: PackageDetailResponse, ...errors },
    },
  }, async (request) => {
    return request.server.packages.setChannels(request.access, request.params.id, request.body);
  });

  app.get('/channels', {
    config: { cache: { tag: 'channels' } },
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_VIEW),
    schema: {
      tags: ['packages'],
      summary: 'All channels this operator distributes',
      querystring: ListChannelsQuery,
      response: { 200: paginated(ChannelResponse), ...errors },
    },
  }, async (request) => {
    return request.server.packages.listChannels(request.access, request.query);
  });
};

export default routes;

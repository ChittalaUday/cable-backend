import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { paginated } from '@/shared/pagination';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from './packages.controller';
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
} from './packages.schema';
import { PackagesService } from './packages.service';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('packages', new PackagesService(app.db));

  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/packages', {
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_VIEW),
    schema: {
      tags: ['packages'],
      summary: 'List packages',
      querystring: ListPackagesQuery,
      response: { 200: paginated(PackageResponse), ...errors },
    },
  }, controller.list);

  app.post('/packages', {
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_CREATE),
    schema: {
      tags: ['packages'],
      summary: 'Add a package to a provider',
      description: 'Money is sent as a decimal string — never a JSON number (§8).',
      body: CreatePackageBody,
      response: { 201: PackageResponse, ...errors },
    },
  }, controller.create);

  app.get('/packages/:id', {
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_VIEW),
    schema: {
      tags: ['packages'],
      summary: 'Read one package with its channel lineup',
      params: IdParams,
      response: { 200: PackageDetailResponse, ...errors },
    },
  }, controller.get);

  app.patch('/packages/:id', {
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_UPDATE),
    schema: {
      tags: ['packages'],
      summary: 'Reprice or edit a package',
      description: 'The provider is fixed — re-pointing a package rewrites what every subscriber is on.',
      params: IdParams,
      body: UpdatePackageBody,
      response: { 200: PackageResponse, ...errors },
    },
  }, controller.update);

  app.delete('/packages/:id', {
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_DELETE),
    schema: {
      tags: ['packages'],
      summary: 'Retire a package nobody is subscribed to',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, controller.remove);

  app.put('/packages/:id/channels', {
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_UPDATE),
    schema: {
      tags: ['packages'],
      summary: 'Replace a package’s channel lineup',
      description: 'Every channel must belong to the same provider. Sending `[]` clears the bouquet.',
      params: IdParams,
      body: SetPackageChannelsBody,
      response: { 200: PackageDetailResponse, ...errors },
    },
  }, controller.setChannels);

  app.get('/channels', {
    preHandler: app.requirePermission(PERMISSIONS.PACKAGES_VIEW),
    schema: {
      tags: ['packages'],
      summary: 'List a provider’s channels, to build a lineup from',
      description: '`packageId` + `inPackage` page through what one package carries, or what is still available to add.',
      querystring: ListChannelsQuery,
      response: { 200: paginated(ChannelResponse), ...errors },
    },
  }, controller.listChannels);
};

export default routes;

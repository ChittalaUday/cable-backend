import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { LocationsService } from '@/modules/locations/location.service';
import { PERMISSIONS } from '@/security/permissions';
import { paginated } from '@/utils/pagination';
import {
  CreateStaffBody,
  IdParams,
  ListStaffQuery,
  SetLocationsBody,
  SetTeamAreasBody,
  StaffResponse,
  UpdateStaffBody,
} from './staff.schema';
import { StaffService } from './staff.service';
import teamRoutes from './staff.team-routes';
import { TeamsService } from './teams.service';
import './staff.types';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const locations = new LocationsService(app.db);

  app.decorate('staff', new StaffService(app.db, locations, app.access));
  app.decorate('teams', new TeamsService(app.db, locations, app.access));

  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/staff', {
    config: { cache: { tag: 'staff' } },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_VIEW),
    schema: {
      tags: ['staff'],
      summary: 'The people this operator employs',
      description: [
        'Every row carries the areas the person reaches, split into the grants held on them (`locations`) and the ones inherited from their crew (`inheritedLocations`) — so a screen can show why someone reaches an area without a second call.',
        '',
        '`locationId` asks the operational question instead: who serves this address? A grant on the node or on any ancestor of it counts, because a grant covers its whole subtree.',
        '',
        'Scoped like every other list: `ALL` returns the tenant, `LOCATION` returns the staff working inside your areas, `TEAM` returns your own crew.',
      ].join('\n'),
      querystring: ListStaffQuery,
      response: { 200: paginated(StaffResponse), ...errors },
    },
  }, async (request) => {
    return request.server.staff.list(request.access, request.query);
  });

  app.post('/staff', {
    config: { invalidates: ['analytics', 'customers', 'inventory', 'staff', 'teams'] },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_CREATE),
    schema: {
      tags: ['staff'],
      summary: 'Hire someone, or give an existing account a job here',
      description: [
        'An `email` or a `phone` is required — one of them is how the person signs in.',
        '',
        'The account is found before it is created: somebody who already signs in as another operator’s subscriber gets a second membership, not a second login. `password` is therefore rejected when the account already exists; those people set their own.',
        '',
        '`locationIds` grants areas in the same call. You can only grant areas you hold yourself, and only a tenant-wide grant may appoint an `admin`.',
      ].join('\n'),
      body: CreateStaffBody,
      response: { 201: StaffResponse, ...errors },
    },
  }, async (request, reply) => {
    const member = await request.server.staff.create(request.access, request.body);
    return reply.status(201).header('location', `${request.url}/${member.id}`).send(member);
  });

  app.get('/staff/:id', {
    config: { cache: { tag: 'staff' } },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_VIEW),
    schema: {
      tags: ['staff'],
      summary: 'One employee, with their active areas resolved',
      params: IdParams,
      response: { 200: StaffResponse, ...errors },
    },
  }, async (request) => {
    return request.server.staff.get(request.access, request.params.id);
  });

  app.patch('/staff/:id', {
    config: { invalidates: ['analytics', 'customers', 'inventory', 'staff', 'teams'] },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_UPDATE),
    schema: {
      tags: ['staff'],
      summary: 'Change name, phone, or crew membership',
      params: IdParams,
      body: UpdateStaffBody,
      response: { 200: StaffResponse, ...errors },
    },
  }, async (request) => {
    return request.server.staff.update(request.access, request.params.id, request.body);
  });

  app.delete('/staff/:id', {
    config: { invalidates: ['analytics', 'staff', 'teams'] },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_DELETE),
    schema: {
      tags: ['staff'],
      summary: 'End someone’s employment here',
      description: 'Their account continues to exist, and their memberships at other operators are untouched. You cannot fire the last `admin`.',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, async (request, reply) => {
    await request.server.staff.remove(request.access, request.params.id);
    return reply.status(204).send(null);
  });

  app.put('/staff/:id/locations', {
    config: { invalidates: ['staff', 'teams'] },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_UPDATE),
    schema: {
      tags: ['staff'],
      summary: 'Replace the areas this person serves directly',
      description: 'Replaces the entire set of direct grants. You cannot grant an area you do not hold yourself.',
      params: IdParams,
      body: SetLocationsBody,
      response: { 200: StaffResponse, ...errors },
    },
  }, async (request) => {
    return request.server.staff.setLocations(request.access, request.params.id, request.body);
  });

  app.put('/staff/:id/team-areas', {
    config: { invalidates: ['staff', 'teams'] },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_UPDATE),
    schema: {
      tags: ['staff'],
      summary: 'Narrow this person to part of their crew’s patch',
      description: 'An empty list widens them back to the crew’s whole patch. Every area must sit inside it.',
      params: IdParams,
      body: SetTeamAreasBody,
      response: { 200: StaffResponse, ...errors },
    },
  }, async (request) => {
    return request.server.staff.setTeamAreas(request.access, request.params.id, request.body);
  });

  await app.register(teamRoutes);
};

export default routes;

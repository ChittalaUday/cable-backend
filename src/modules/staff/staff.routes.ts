import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { LocationsService } from '@/modules/locations/locations.service';
import { paginated } from '@/shared/pagination';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from './staff.controller';
import {
  CreateStaffBody,
  IdParams,
  ListStaffQuery,
  SetLocationsBody,
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
  }, controller.list);

  app.post('/staff', {
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
  }, controller.create);

  app.get('/staff/:id', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_VIEW),
    schema: {
      tags: ['staff'],
      summary: 'One staff member, with their crew and areas resolved',
      params: IdParams,
      response: { 200: StaffResponse, ...errors },
    },
  }, controller.get);

  app.patch('/staff/:id', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_UPDATE),
    schema: {
      tags: ['staff'],
      summary: 'Change the job: role, status, or crew',
      description: 'Moving someone to a crew is how they join it — there is no second write path on the team. `name` corrects the global account, so it changes everywhere that person appears.',
      params: IdParams,
      body: UpdateStaffBody,
      response: { 200: StaffResponse, ...errors },
    },
  }, controller.update);

  app.delete('/staff/:id', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_DELETE),
    schema: {
      tags: ['staff'],
      summary: 'End the job — the account survives',
      description: 'Removes the membership and its area grants. The `auth.users` row stays: the same person may be a subscriber elsewhere, and revoking a role is not a reason to delete a login.',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, controller.remove);

  app.put('/staff/:id/locations', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_UPDATE),
    schema: {
      tags: ['staff'],
      summary: 'Replace the areas this person reaches',
      description: 'A set, not a diff: send the whole list. A node covers everything beneath it, so an apartment is one id rather than one per door. Areas inherited from a crew are not editable here.',
      params: IdParams,
      body: SetLocationsBody,
      response: { 200: StaffResponse, ...errors },
    },
  }, controller.setLocations);

  await app.register(teamRoutes);
};

export default routes;

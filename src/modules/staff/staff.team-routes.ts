import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { paginated } from '@/shared/pagination';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from './staff.controller';
import {
  CreateTeamBody,
  IdParams,
  ListTeamsQuery,
  SetLocationsBody,
  SetTeamAreasBody,
  StaffResponse,
  TeamMemberResponse,
  TeamResponse,
  UpdateTeamBody,
} from './staff.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/teams', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_VIEW),
    schema: {
      tags: ['teams'],
      summary: 'The operator’s crews, with their size and their areas',
      querystring: ListTeamsQuery,
      response: { 200: paginated(TeamResponse), ...errors },
    },
  }, controller.listTeams);

  app.post('/teams', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_CREATE),
    schema: {
      tags: ['teams'],
      summary: 'Start a crew',
      description: '`slug` is derived from the name when absent. `locationIds` grants the crew its areas in the same call; you can only grant areas you hold yourself.',
      body: CreateTeamBody,
      response: { 201: TeamResponse, ...errors },
    },
  }, controller.createTeam);

  app.get('/teams/:id', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_VIEW),
    schema: {
      tags: ['teams'],
      summary: 'One crew',
      params: IdParams,
      response: { 200: TeamResponse, ...errors },
    },
  }, controller.getTeam);

  app.get('/teams/:id/members', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_VIEW),
    schema: {
      tags: ['teams'],
      summary: 'Who is on this crew, and what each of them covers',
      description: 'Leaders first. `teamAreas` is the member’s share of the crew’s patch — **empty means all of it**, not none. `locations` are grants held on the person, which the crew does not limit.',
      params: IdParams,
      response: { 200: Type.Array(TeamMemberResponse), ...errors },
    },
  }, controller.teamMembers);

  app.patch('/teams/:id', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_UPDATE),
    schema: {
      tags: ['teams'],
      summary: 'Rename a crew, or retire it',
      params: IdParams,
      body: UpdateTeamBody,
      response: { 200: TeamResponse, ...errors },
    },
  }, controller.updateTeam);

  app.delete('/teams/:id', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_DELETE),
    schema: {
      tags: ['teams'],
      summary: 'Disband an empty crew',
      description: 'A crew with members is a 409: emptying it would silently strip every member’s inherited areas. Move them off it first (`PATCH /staff/:id`).',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, controller.removeTeam);

  app.put('/staff/:id/team-areas', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_UPDATE),
    schema: {
      tags: ['staff'],
      summary: 'Narrow this person to part of their crew’s patch',
      description: [
        'A crew grants its whole patch to everyone on it. This says which part of it *this* member covers — the round splits four ways, and each collector works their own blocks.',
        '',
        'It NARROWS and never adds: every node must sit inside one of the crew’s own areas, and an empty list removes the narrowing and puts them back on all of it. Areas granted to the person directly (`PUT /staff/:id/locations`) are unaffected — the crew was never able to limit those.',
        '',
        'A 400 if they are on no crew: there is nothing to narrow.',
      ].join('\n'),
      params: IdParams,
      body: SetTeamAreasBody,
      response: { 200: StaffResponse, ...errors },
    },
  }, controller.setTeamAreas);

  app.put('/teams/:id/locations', {
    preHandler: app.requirePermission(PERMISSIONS.STAFF_UPDATE),
    schema: {
      tags: ['teams'],
      summary: 'Replace the areas the whole crew reaches',
      description: 'The reason teams exist: grant the collection round three apartments once instead of once per member. Every current member reaches them immediately, and anyone moved onto the crew later inherits them.',
      params: IdParams,
      body: SetLocationsBody,
      response: { 200: TeamResponse, ...errors },
    },
  }, controller.setTeamLocations);
};

export default routes;

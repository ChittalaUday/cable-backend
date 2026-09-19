import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/security/permissions';
import { paginated } from '@/utils/pagination';
import {
  CreateTeamBody,
  IdParams,
  ListTeamsQuery,
  SetLocationsBody,
  TeamMemberResponse,
  TeamResponse,
  UpdateTeamBody,
} from './staff.schema';

const teamRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/teams', {
    config: { cache: { tag: 'teams' } },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_VIEW),
    schema: {
      tags: ['staff'],
      summary: 'Crews operating within the business',
      querystring: ListTeamsQuery,
      response: { 200: paginated(TeamResponse), ...errors },
    },
  }, async (request) => {
    return request.server.teams.list(request.access, request.query);
  });

  app.post('/teams', {
    config: { invalidates: ['analytics', 'customers', 'inventory', 'staff', 'teams'] },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_CREATE),
    schema: {
      tags: ['staff'],
      summary: 'Form a crew',
      body: CreateTeamBody,
      response: { 201: TeamResponse, ...errors },
    },
  }, async (request, reply) => {
    const team = await request.server.teams.create(request.access, request.body);
    return reply.status(201).header('location', `${request.url}/${team.id}`).send(team);
  });

  app.get('/teams/:id', {
    config: { cache: { tag: 'teams' } },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_VIEW),
    schema: {
      tags: ['staff'],
      summary: 'One crew with its operational areas resolved',
      params: IdParams,
      response: { 200: TeamResponse, ...errors },
    },
  }, async (request) => {
    return request.server.teams.get(request.access, request.params.id);
  });

  app.patch('/teams/:id', {
    config: { invalidates: ['analytics', 'customers', 'inventory', 'staff', 'teams'] },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_UPDATE),
    schema: {
      tags: ['staff'],
      summary: 'Rename a crew or appoint a leader',
      params: IdParams,
      body: UpdateTeamBody,
      response: { 200: TeamResponse, ...errors },
    },
  }, async (request) => {
    return request.server.teams.update(request.access, request.params.id, request.body);
  });

  app.delete('/teams/:id', {
    config: { invalidates: ['analytics', 'customers', 'inventory', 'staff', 'teams'] },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_DELETE),
    schema: {
      tags: ['staff'],
      summary: 'Disband a crew',
      description: 'Members lose the crew’s inherited areas. Their direct grants and accounts are untouched.',
      params: IdParams,
      response: { 204: Type.Null(), ...errors },
    },
  }, async (request, reply) => {
    await request.server.teams.remove(request.access, request.params.id);
    return reply.status(204).send(null);
  });

  app.get('/teams/:id/members', {
    config: { cache: { tag: 'teams' } },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_VIEW),
    schema: {
      tags: ['staff'],
      summary: 'The people on this crew',
      params: IdParams,
      response: { 200: Type.Array(TeamMemberResponse), ...errors },
    },
  }, async (request) => {
    return request.server.teams.members(request.access, request.params.id);
  });

  app.put('/teams/:id/locations', {
    config: { invalidates: ['analytics', 'customers', 'inventory', 'staff', 'teams'] },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_UPDATE),
    schema: {
      tags: ['staff'],
      summary: 'Replace the areas this crew serves',
      description: 'Every crew member inherits these areas.',
      params: IdParams,
      body: SetLocationsBody,
      response: { 200: TeamResponse, ...errors },
    },
  }, async (request) => {
    return request.server.teams.setLocations(request.access, request.params.id, request.body);
  });
};

export default teamRoutes;

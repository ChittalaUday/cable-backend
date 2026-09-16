import type { FastifyReply } from 'fastify';
import type {
  CreateStaffBody,
  CreateTeamBody,
  IdParams,
  ListStaffQuery,
  ListTeamsQuery,
  SetLocationsBody,
  SetTeamAreasBody,
  UpdateStaffBody,
  UpdateTeamBody,
} from './staff.schema';
import type { Req } from '@/shared/types/request';

export async function list(request: Req<{ querystring: typeof ListStaffQuery }>) {
  return request.server.staff.list(request.access, request.query);
}

export async function get(request: Req<{ params: typeof IdParams }>) {
  return request.server.staff.get(request.access, request.params.id);
}

export async function create(request: Req<{ body: typeof CreateStaffBody }>, reply: FastifyReply) {
  const member = await request.server.staff.create(request.access, request.body);

  return reply.status(201).header('location', `${request.url}/${member.id}`).send(member);
}

export async function update(request: Req<{ params: typeof IdParams; body: typeof UpdateStaffBody }>) {
  return request.server.staff.update(request.access, request.params.id, request.body);
}

export async function remove(request: Req<{ params: typeof IdParams }>, reply: FastifyReply) {
  await request.server.staff.remove(request.access, request.params.id);

  return reply.status(204).send();
}

export async function setLocations(request: Req<{ params: typeof IdParams; body: typeof SetLocationsBody }>) {
  return request.server.staff.setLocations(request.access, request.params.id, request.body);
}

export async function setTeamAreas(request: Req<{ params: typeof IdParams; body: typeof SetTeamAreasBody }>) {
  return request.server.staff.setTeamAreas(request.access, request.params.id, request.body);
}

export async function listTeams(request: Req<{ querystring: typeof ListTeamsQuery }>) {
  return request.server.teams.list(request.access, request.query);
}

export async function getTeam(request: Req<{ params: typeof IdParams }>) {
  return request.server.teams.get(request.access, request.params.id);
}

export async function createTeam(request: Req<{ body: typeof CreateTeamBody }>, reply: FastifyReply) {
  const team = await request.server.teams.create(request.access, request.body);

  return reply.status(201).header('location', `${request.url}/${team.id}`).send(team);
}

export async function updateTeam(request: Req<{ params: typeof IdParams; body: typeof UpdateTeamBody }>) {
  return request.server.teams.update(request.access, request.params.id, request.body);
}

export async function removeTeam(request: Req<{ params: typeof IdParams }>, reply: FastifyReply) {
  await request.server.teams.remove(request.access, request.params.id);

  return reply.status(204).send();
}

export async function teamMembers(request: Req<{ params: typeof IdParams }>) {
  return request.server.teams.members(request.access, request.params.id);
}

export async function setTeamLocations(request: Req<{ params: typeof IdParams; body: typeof SetLocationsBody }>) {
  return request.server.teams.setLocations(request.access, request.params.id, request.body);
}

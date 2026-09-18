import type { StaffService } from './services/staff.service';
import type { TeamsService } from './services/teams.service';

declare module 'fastify' {
  interface FastifyInstance {
    staff: StaffService;
    teams: TeamsService;
  }
}

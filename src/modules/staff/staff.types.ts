import type { StaffService } from './staff.service';
import type { TeamsService } from './teams.service';

declare module 'fastify' {
  interface FastifyInstance {
    staff: StaffService;
    teams: TeamsService;
  }
}

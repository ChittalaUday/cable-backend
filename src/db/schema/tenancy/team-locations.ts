import { index, unique, uuid } from 'drizzle-orm/pg-core';
import { locations } from '../geo/locations';
import { tenancy } from '../schemas';
import { teams } from './teams';

export const teamLocations = tenancy.table('team_locations', {
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
}, table => [
  unique('team_locations_uq').on(table.teamId, table.locationId),
  index('team_locations_location_idx').on(table.locationId),
]);

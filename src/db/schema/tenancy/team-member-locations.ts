import { index, unique, uuid } from 'drizzle-orm/pg-core';
import { locations } from '../geo/locations';
import { tenancy } from '../schemas';
import { tenantMemberships } from './tenant-memberships';

export const teamMemberLocations = tenancy.table('team_member_locations', {
  membershipId: uuid('membership_id').notNull().references(() => tenantMemberships.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
}, table => [
  unique('team_member_locations_uq').on(table.membershipId, table.locationId),
  index('team_member_locations_location_idx').on(table.locationId),
]);

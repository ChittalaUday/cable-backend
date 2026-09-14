import { unique, uuid } from 'drizzle-orm/pg-core';
import { locations } from '../geo/locations';
import { tenancy } from '../schemas';
import { tenantMemberships } from './tenant-memberships';

export const membershipLocations = tenancy.table('membership_locations', {
  membershipId: uuid('membership_id').notNull().references(() => tenantMemberships.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
}, table => [
  unique('membership_locations_uq').on(table.membershipId, table.locationId),
]);

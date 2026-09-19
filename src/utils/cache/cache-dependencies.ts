/**
 * What each cached read actually touches, and what each write actually changes.
 *
 * Invalidation is by version counter per tag (see `CacheService`), so a write
 * must bump every tag whose reads overlap the tables it wrote — not just the
 * tag whose URL it shares. Deriving that by eye is the mistake this file
 * exists to stop: `cache-dependencies.test.ts` checks the `invalidates` on
 * every route against the two tables below and fails on a gap.
 *
 * Relations are physical (`schema.table`). Views and set-returning functions
 * are written as the tables they read, because a write to the table changes
 * what the view returns:
 *   geo.location_paths / location_ancestors / location_descendants -> geo.locations
 *   crm.coverage_allows -> crm.service_coverage (+ geo.locations, via ancestors)
 *
 * The caller's OWN grant is deliberately absent from most read sets. A reach
 * predicate built from `access.locationIds` is folded into the cache key by
 * `scopeIdFor`, so re-granting someone lands them on a different key with no
 * tag bump at all. `tenancy.membership_locations` and friends appear only under
 * `staff` and `teams`, which render *other people's* grants as payload.
 *
 * Over-invalidation is allowed: dropping a tag a write cannot have changed
 * costs one cache generation, while missing one serves a stale answer. Only the
 * under-invalidation direction is enforced.
 */

/** Tables every read behind a cache tag touches, transitively. */
export const TAG_READS: Readonly<Record<string, readonly string[]>> = {
  'analytics': [
    'crm.customers',
    'crm.subscriptions',
    'crm.service_providers',
    'crm.services',
    'crm.account_transactions',
    'auth.users',
    'geo.locations',
    'tenancy.tenant_memberships',
  ],
  'channels': [
    'crm.channels',
    'crm.package_channels',
    'crm.service_providers',
    'crm.service_coverage',
    'geo.locations',
  ],
  'coverage': [
    'crm.service_coverage',
    'crm.services',
    'crm.service_providers',
    'crm.packages',
    'geo.locations',
  ],
  'customers': [
    'crm.customers',
    'crm.subscriptions',
    'crm.service_providers',
    'crm.services',
    'crm.packages',
    'crm.account_transactions',
    'auth.users',
    'geo.locations',
    'inventory.customer_equipment',
    'inventory.equipment',
    'inventory.item_catalog',
  ],
  'inventory': [
    'inventory.item_catalog',
    'inventory.equipment',
    'inventory.stock_movements',
    'inventory.customer_equipment',
    'inventory.approval_requests',
    'crm.customers',
    'auth.users',
    'geo.locations',
    'tenancy.tenant_memberships',
  ],
  'location-config': [
    'geo.location_categories',
    'geo.location_schemas',
    'geo.location_schema_levels',
  ],
  'locations': [
    'geo.locations',
    'geo.location_aliases',
    'crm.service_coverage',
  ],
  'packages': [
    'crm.packages',
    'crm.package_channels',
    'crm.channels',
    'crm.service_providers',
    'crm.services',
    'crm.service_coverage',
    'geo.locations',
  ],
  'payments': [
    'billing.collections',
    'crm.customers',
    'crm.subscriptions',
    'auth.users',
    'geo.locations',
  ],
  'remotes': ['remotes.remotes', 'remotes.remote_captures'],
  'service-providers': [
    'crm.service_providers',
    'crm.services',
    'crm.packages',
    'crm.service_coverage',
    'geo.locations',
  ],
  'services': [
    'crm.services',
    'crm.service_providers',
    'crm.packages',
    'crm.service_coverage',
    'geo.locations',
  ],
  'staff': [
    'tenancy.tenant_memberships',
    'tenancy.teams',
    'tenancy.membership_locations',
    'tenancy.team_locations',
    'tenancy.team_member_locations',
    'auth.users',
    'geo.locations',
  ],
  'teams': [
    'tenancy.teams',
    'tenancy.tenant_memberships',
    'tenancy.team_locations',
    'tenancy.membership_locations',
    'tenancy.team_member_locations',
    'auth.users',
    'geo.locations',
  ],
};

/**
 * Tables each mutating route writes, including what its cascades take with it.
 * Keyed exactly as the route table prints it.
 */
export const ROUTE_WRITES: Readonly<Record<string, readonly string[]>> = {
  'POST /api/v1/location-categories': ['geo.location_categories'],
  'PATCH /api/v1/location-categories/:id': ['geo.location_categories'],
  'DELETE /api/v1/location-categories/:id': ['geo.location_categories'],
  'POST /api/v1/location-schemas': ['geo.location_schemas', 'geo.location_schema_levels'],
  'PATCH /api/v1/location-schemas/:id': ['geo.location_schemas'],
  'DELETE /api/v1/location-schemas/:id': ['geo.location_schemas'],
  'POST /api/v1/location-schemas/:id/generate': ['geo.locations'],

  'POST /api/v1/locations': ['geo.locations', 'geo.location_aliases'],
  'PATCH /api/v1/locations/:id': ['geo.locations', 'geo.location_aliases'],
  'DELETE /api/v1/locations/:id': ['geo.locations', 'geo.location_aliases'],

  'POST /api/v1/services': ['crm.services'],
  'PATCH /api/v1/services/:id': ['crm.services'],
  // A soft delete leaves the coverage rows, but the row itself vanishes from
  // every read that joins it.
  'DELETE /api/v1/services/:id': ['crm.services'],
  'POST /api/v1/service-providers': ['crm.service_providers'],
  'PATCH /api/v1/service-providers/:id': ['crm.service_providers'],
  'DELETE /api/v1/service-providers/:id': ['crm.service_providers'],

  'PUT /api/v1/services/:id/coverage': ['crm.service_coverage'],
  'PUT /api/v1/service-providers/:id/coverage': ['crm.service_coverage'],
  'PUT /api/v1/packages/:id/coverage': ['crm.service_coverage'],

  'POST /api/v1/packages': ['crm.packages'],
  'PATCH /api/v1/packages/:id': ['crm.packages'],
  'DELETE /api/v1/packages/:id': ['crm.packages'],
  'PUT /api/v1/packages/:id/channels': ['crm.package_channels'],

  'POST /api/v1/staff': ['tenancy.tenant_memberships', 'auth.users', 'tenancy.membership_locations'],
  'PATCH /api/v1/staff/:id': [
    'tenancy.tenant_memberships',
    'auth.users',
    'tenancy.team_member_locations',
    'tenancy.teams',
  ],
  'DELETE /api/v1/staff/:id': [
    'tenancy.tenant_memberships',
    'tenancy.membership_locations',
    'tenancy.team_member_locations',
    'tenancy.teams',
  ],
  'PUT /api/v1/staff/:id/locations': ['tenancy.membership_locations'],
  'PUT /api/v1/staff/:id/team-areas': ['tenancy.team_member_locations'],

  'POST /api/v1/teams': ['tenancy.teams', 'tenancy.team_locations'],
  'PATCH /api/v1/teams/:id': ['tenancy.teams'],
  'DELETE /api/v1/teams/:id': ['tenancy.teams', 'tenancy.tenant_memberships'],
  'PUT /api/v1/teams/:id/locations': ['tenancy.team_locations'],

  'POST /api/v1/inventory/catalog': ['inventory.item_catalog'],
  'PUT /api/v1/inventory/catalog/:id': ['inventory.item_catalog'],
  'DELETE /api/v1/inventory/catalog/:id': ['inventory.item_catalog'],
  // Issuing can mint the subscription the unit hangs off, so it writes crm too.
  'POST /api/v1/inventory/issue': [
    'inventory.equipment',
    'inventory.customer_equipment',
    'inventory.stock_movements',
    'crm.subscriptions',
  ],
  'POST /api/v1/inventory/return': [
    'inventory.customer_equipment',
    'inventory.equipment',
    'inventory.stock_movements',
  ],
  'POST /api/v1/inventory/inward': ['inventory.equipment', 'inventory.stock_movements'],
  'POST /api/v1/inventory/transfer': ['inventory.equipment', 'inventory.stock_movements'],
  'POST /api/v1/inventory/approval-requests': ['inventory.approval_requests'],
  // Approving one applies the proposed catalog change.
  'PATCH /api/v1/inventory/approval-requests/:id': ['inventory.approval_requests', 'inventory.item_catalog'],

  'POST /api/v1/payments': [
    'billing.collections',
    'crm.account_transactions',
    'crm.customers',
    'crm.subscriptions',
  ],
  'POST /api/v1/payments/:id/reverse': [
    'billing.collections',
    'crm.account_transactions',
    'crm.customers',
    'crm.subscriptions',
  ],

  'POST /api/v1/remotes': ['remotes.remotes'],
};

/**
 * Pairs the relation-level model calls a dependency but a column-level reading
 * does not. Each one is a write that touches a table another tag reads, in a
 * column that tag never renders.
 */
export const NOT_REALLY_READ: Readonly<Record<string, string>> = {
  'POST /api/v1/payments -> inventory':
    'Payments move crm.customers.outstanding_balance; the inventory reads take only the name and code off that row.',
  'POST /api/v1/payments/:id/reverse -> inventory':
    'Same.',
  'POST /api/v1/inventory/issue -> payments':
    'Issuing can mint a subscription, but a receipt only renders subscriptions that already carry a collection.',
};

/**
 * A first sign-in claims the `crm.customers` rows carrying that phone number
 * and sets `user_id` on them. The customer list and the analytics dashboard
 * both render `coalesce(users.name, customers.name)`, so an admin holding a
 * cached page keeps seeing the pre-link name until the TTL runs out.
 *
 * It is left uninvalidated on purpose for now: the alternative is dropping the
 * tenant's customers and analytics caches on *every* sign-in, and the linking
 * branch only fires on the first one. Making it conditional needs the service
 * to reach the cache itself, which crosses a layer boundary — decide before
 * building. Until then this is a known, bounded staleness, not an oversight.
 */
export const KNOWN_STALENESS: Readonly<Record<string, string>> = {
  'first sign-in -> customers':
    'auth links crm.customers.user_id; the list shows coalesce(users.name, customers.name).',
  'first sign-in -> analytics':
    'The same coalesce feeds recentCustomers on the admin dashboard.',
};

/** Routes that write nothing a cached read renders. */
export const NO_CACHE_EFFECT: Readonly<Record<string, string>> = {
  'POST /api/v1/auth/otp/request': 'Writes auth.otp_codes, which no cached read touches.',
  'POST /api/v1/auth/otp/verify': 'Links a subscriber on first sign-in — see KNOWN_STALENESS.',
  'POST /api/v1/auth/login': 'Links a subscriber on first sign-in — see KNOWN_STALENESS.',
  'POST /api/v1/auth/google': 'Links a subscriber on first sign-in — see KNOWN_STALENESS.',
  'POST /api/v1/auth/refresh': 'Rotates a refresh token.',
  'POST /api/v1/auth/logout': 'Revokes a session.',
  'POST /api/v1/auth/logout-all': 'Revokes sessions.',
  'POST /api/v1/files': 'media.files is read by its own uncached route.',
  'DELETE /api/v1/files/:id': 'Same.',
  'POST /api/v1/notifications/send': 'notify.notifications is read by its own uncached route.',
  'PATCH /api/v1/notifications/:id/read': 'Same.',
  'PATCH /api/v1/notifications/read-all': 'Same.',
  'POST /api/v1/notifications/token': 'Writes auth.devices.push_token.',
};

export function tagsAffectedBy(route: string, written: readonly string[]): string[] {
  const touched = new Set(written);

  return Object.entries(TAG_READS)
    .filter(([, reads]) => reads.some(relation => touched.has(relation)))
    .map(([tag]) => tag)
    .filter(tag => !(`${route} -> ${tag}` in NOT_REALLY_READ))
    .sort();
}

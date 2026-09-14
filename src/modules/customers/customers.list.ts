import type { SQL } from 'drizzle-orm';
import type { CustomerListItem, CustomerPage, ListCustomersQuery } from './customers.schema';
import type { Db } from './customers.service';
import type { RequestAccess } from '@/modules/iam/access.service';
import { Buffer } from 'node:buffer';
import { and, count, desc, eq, exists, gte, ilike, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { customers, subscriptions, users } from '@/db/schema';
import { grantedNodes, scopeFor } from '@/modules/iam/access.service';
import { BOX_EQUIPMENT_TYPES } from '@/shared/constants/crm';
import { ERROR_CODES } from '@/shared/errors';
import { badRequest, forbidden } from '@/shared/errors/domain-error';
import { PERMISSIONS } from '@/shared/security/permissions';
import { hydrateCustomerItems } from './customers.search';

interface PathRow extends Record<string, unknown> {
  id: string;
  path: string;
}

/**
 * The name and phone a staff screen shows.
 *
 * `auth.users` is the identity of record, so once a subscriber has a login it
 * wins. `crm.customers.name` is the fallback for the imported back catalogue,
 * which has no account yet — see the note on that column. Resolving it here,
 * once, is what stops half the app showing the import's spelling and the other
 * half the account's.
 */
const displayName = sql<string | null>`coalesce(${users.name}, ${customers.name})`;
const displayPhone = sql<string | null>`coalesce(${users.phone}, ${customers.phone})`;

/**
 * Where the next page resumes: the last row's sort key, opaque to the client.
 *
 * It encodes exactly the `(created_at, id)` the ordering uses, so resuming is an
 * index seek rather than a count-and-skip.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = at === undefined ? new Date(Number.NaN) : new Date(at);

  if (id === undefined || Number.isNaN(createdAt.getTime()))
    throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Malformed cursor');

  return { createdAt, id };
}

/**
 * The subtree filter for a caller whose grant is an area rather than the tenant.
 *
 * A customer is IN an area if their own node is, or if any line they hold is
 * installed there — `subscriptions.locationId` is the address of record, and a
 * customer whose account node is unset would otherwise be invisible to the very
 * staff who serve them.
 *
 * `null` means the caller holds the permission but has been granted no area at
 * all, which is not the same as "everything": it is an empty list.
 */
export function reachCondition(access: RequestAccess): SQL[] | null {
  const scope = scopeFor(access, PERMISSIONS.CUSTOMERS_VIEW);

  if (scope === null)
    throw forbidden(ERROR_CODES.PERM_DENIED, `Missing permission: ${PERMISSIONS.CUSTOMERS_VIEW}`);

  if (scope === 'ALL')
    return [];

  if (scope === 'OWN')
    return [eq(customers.userId, access.userId)];

  const granted = grantedNodes(access, scope);
  if (granted.length === 0)
    return null;

  const within = (column: SQL) => sql`EXISTS (
    SELECT 1 FROM unnest(${sql.param(granted)}::uuid[]) AS g(id), geo.location_descendants(g.id) AS d
    WHERE d.id = ${column}
  )`;

  return [sql`(${within(sql`${customers.locationId}`)} OR EXISTS (
    SELECT 1 FROM crm.subscriptions s
    WHERE s.customer_id = ${customers.id}
      AND s.deleted_at IS NULL
      AND ${within(sql`s.location_id`)}
  ))`];
}

export function subtreeFilter(locationId: string): SQL {
  return sql`(EXISTS (
    SELECT 1 FROM geo.location_descendants(${locationId}) AS d WHERE d.id = ${customers.locationId}
  ) OR EXISTS (
    SELECT 1 FROM crm.subscriptions s
    JOIN geo.location_descendants(${locationId}) AS d ON d.id = s.location_id
    WHERE s.customer_id = ${customers.id} AND s.deleted_at IS NULL
  ))`;
}

export function multiBoxFilter(tenantId: string): SQL {
  return sql`(
    EXISTS (
      SELECT 1
      FROM crm.subscriptions s
      JOIN crm.service_providers sp ON sp.id = s.service_provider_id
      WHERE s.customer_id = ${customers.id}
        AND s.tenant_id = ${tenantId}
        AND s.deleted_at IS NULL
      GROUP BY sp.service_id
      HAVING count(*) >= 2
    )
    OR EXISTS (
      SELECT 1
      FROM crm.customer_equipment ce
      JOIN crm.equipment eq ON eq.id = ce.equipment_id
      JOIN crm.subscriptions s ON s.id = ce.subscription_id
      JOIN crm.service_providers sp ON sp.id = s.service_provider_id
      WHERE ce.customer_id = ${customers.id}
        AND ce.tenant_id = ${tenantId}
        AND ce.status = 'active'
        AND s.deleted_at IS NULL
        AND eq.equipment_type = ANY(${sql.param([...BOX_EQUIPMENT_TYPES])})
      GROUP BY sp.service_id
      HAVING count(*) >= 2
    )
  )`;
}

/** Which customers the caller asked for, within what they are allowed to see. */
function filtersFor(db: Db, access: RequestAccess, query: ListCustomersQuery): SQL[] {
  // Non-null: the caller returns early when the reach is empty.
  const reach = reachCondition(access)!;

  const filters: SQL[] = [
    eq(customers.tenantId, access.tenantId),
    isNull(customers.deletedAt),
    ...reach,
  ];

  if (query.status !== undefined)
    filters.push(eq(customers.status, query.status));

  if (query.locationId !== undefined)
    filters.push(subtreeFilter(query.locationId));

  if (query.multiBox)
    filters.push(multiBoxFilter(access.tenantId));

  if (query.q !== undefined) {
    const term = `%${query.q}%`;
    // Both sides of the identity: the account's name once there is one, the
    // import's until then. All five columns carry a trigram index, so a leading
    // wildcard is still an index scan rather than a sequential one.
    filters.push(or(
      ilike(customers.name, term),
      ilike(customers.phone, term),
      ilike(customers.customerCode, term),
      ilike(users.name, term),
      ilike(users.phone, term),
    )!);
  }

  // These two filter on the LINE, not the customer, so they are an EXISTS rather
  // than a join — a customer on three of the provider's packages must still come
  // back as one row, not three.
  const onLine = (condition: SQL) => exists(db.select({ one: sql`1` }).from(subscriptions).where(and(
    eq(subscriptions.customerId, customers.id),
    isNull(subscriptions.deletedAt),
    condition,
  )));

  if (query.serviceProviderId !== undefined)
    filters.push(onLine(eq(subscriptions.serviceProviderId, query.serviceProviderId)));

  if (query.packageId !== undefined)
    filters.push(onLine(eq(subscriptions.packageId, query.packageId)));

  if (query.createdFrom !== undefined)
    filters.push(gte(customers.createdAt, new Date(query.createdFrom)));

  if (query.createdTo !== undefined)
    filters.push(lte(customers.createdAt, new Date(query.createdTo)));

  if (query.cursor !== undefined) {
    const { createdAt, id } = decodeCursor(query.cursor);
    // Row-wise comparison, matching `ORDER BY created_at DESC, id DESC` exactly.
    // Two customers can share a timestamp to the microsecond after an import, so
    // the id is what makes the boundary total and the page stable.
    filters.push(or(
      lt(customers.createdAt, createdAt),
      and(eq(customers.createdAt, createdAt), lt(customers.id, id)),
    )!);
  }

  return filters;
}

/**
 * A page of customers, with every searchable value already resolved.
 *
 * The page is selected first, then accounts, locations and equipment are
 * hydrated in batches for all customer ids rather than queried once per row.
 * The count runs only on the first page.
 */
export async function listCustomers(
  db: Db,
  access: RequestAccess,
  query: ListCustomersQuery,
): Promise<CustomerPage> {
  if (reachCondition(access) === null)
    return { items: [], total: 0, limit: query.limit, nextCursor: null };

  const where = and(...filtersFor(db, access, query));
  const firstPage = query.cursor === undefined;

  const [rows, [totals]] = await Promise.all([
    db.select({
      id: customers.id,
      customerCode: customers.customerCode,
      name: displayName,
      phone: displayPhone,
      status: customers.status,
      outstandingBalance: customers.outstandingBalance,
      locationId: customers.locationId,
      createdAt: customers.createdAt,
    })
      .from(customers)
      .leftJoin(users, eq(users.id, customers.userId))
      .where(where)
      .orderBy(desc(customers.createdAt), desc(customers.id))
      // One more than asked for, so "is there another page" costs no extra query.
      .limit(query.limit + 1),
    firstPage
      ? db.select({ total: count() })
          .from(customers)
          .leftJoin(users, eq(users.id, customers.userId))
          .where(where)
      : Promise.resolve([undefined]),
  ]);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page.at(-1);

  if (last === undefined)
    return { items: [], total: firstPage ? totals?.total ?? 0 : null, limit: query.limit, nextCursor: null };

  const items: CustomerListItem[] = await hydrateCustomerItems(
    db,
    access,
    page.map(row => ({ customerId: row.id })),
  );

  return {
    items,
    total: firstPage ? totals?.total ?? 0 : null,
    limit: query.limit,
    nextCursor: hasMore ? encodeCursor(last.createdAt, last.id) : null,
  };
}

/**
 * Breadcrumbs for a set of nodes in one round trip.
 *
 * The same `location_ancestors` walk the locations module uses, run for every id
 * on the page at once rather than once per row.
 */
export async function locationPaths(db: Db, locationIds: string[]): Promise<Map<string, string>> {
  if (locationIds.length === 0)
    return new Map();

  const result = await db.execute<PathRow>(sql`
    SELECT n.id,
           string_agg(l.name, ' / ' ORDER BY a.depth DESC) AS path
    FROM unnest(${sql.param(locationIds)}::uuid[]) AS n(id)
    CROSS JOIN geo.location_ancestors(n.id) AS a
    JOIN geo.locations l ON l.id = a.id
    GROUP BY n.id
  `);

  return new Map(result.rows.map(row => [row.id, row.path]));
}

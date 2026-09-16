import type { SQL } from 'drizzle-orm';
import type { CustomerListItem, CustomerPage, ListCustomersQuery } from './customers.schema';
import type { Db } from './customers.service';
import type { RequestAccess } from '@/modules/iam/access.service';
import { Buffer } from 'node:buffer';
import { and, count, desc, eq, exists, gte, ilike, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { customers, subscriptions, users } from '@/db/schema';
import { locationScopeFor, requireScope } from '@/modules/iam/access.service';
import { ERROR_CODES } from '@/shared/errors';
import { badRequest } from '@/shared/errors/domain-error';
import { withinGrantedSubtree } from '@/shared/security/location-scope';
import { PERMISSIONS } from '@/shared/security/permissions';
import { likeTerm } from '@/shared/utils/search';
import { hydrateCustomerItems } from './customers.search';

interface PathRow extends Record<string, unknown> {
  id: string;
  path: string;
}

const displayName = sql<string | null>`coalesce(${users.name}, ${customers.name})`;
const displayPhone = sql<string | null>`coalesce(${users.phone}, ${customers.phone})`;

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

export function customerWithinNodes(
  nodeIds: readonly string[],
  columns: { id: SQL; locationId: SQL },
): SQL {
  const within = (column: SQL) => withinGrantedSubtree(column, nodeIds);

  return sql`(${within(columns.locationId)} OR EXISTS (
    SELECT 1 FROM crm.subscriptions s
    WHERE s.customer_id = ${columns.id}
      AND s.deleted_at IS NULL
      AND ${within(sql`s.location_id`)}
  ))`;
}

export function reachCondition(access: RequestAccess): SQL[] | null {
  const scope = requireScope(access, PERMISSIONS.CUSTOMERS_VIEW);

  if (scope === 'OWN')
    return [eq(customers.userId, access.userId)];

  const reach = locationScopeFor(access, PERMISSIONS.CUSTOMERS_VIEW);

  if (reach.kind === 'ALL_TENANT_LOCATIONS')
    return [];

  if (reach.nodeIds.length === 0)
    return null;

  return [customerWithinNodes(reach.nodeIds, {
    id: sql`${customers.id}`,
    locationId: sql`${customers.locationId}`,
  })];
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
      FROM inventory.customer_equipment ce
      JOIN inventory.equipment eq ON eq.id = ce.equipment_id
      JOIN crm.subscriptions s ON s.id = ce.subscription_id
      JOIN crm.service_providers sp ON sp.id = s.service_provider_id
      WHERE ce.customer_id = ${customers.id}
        AND ce.tenant_id = ${tenantId}
        AND ce.status = 'active'
        AND s.deleted_at IS NULL
        AND eq.parent_equipment_id IS NULL
      GROUP BY sp.service_id
      HAVING count(*) >= 2
    )
  )`;
}

export function baseFilters(db: Db, access: RequestAccess, query: ListCustomersQuery): SQL[] | null {
  const reach = reachCondition(access);
  if (reach === null)
    return null;

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

  return filters;
}

function filtersFor(db: Db, access: RequestAccess, query: ListCustomersQuery): SQL[] {
  const filters = baseFilters(db, access, query)!;

  if (query.q !== undefined) {
    const term = likeTerm(query.q);
    filters.push(or(
      ilike(customers.name, term),
      ilike(customers.phone, term),
      ilike(customers.customerCode, term),
      ilike(users.name, term),
      ilike(users.phone, term),
    )!);
  }

  if (query.cursor !== undefined) {
    const { createdAt, id } = decodeCursor(query.cursor);
    filters.push(or(
      lt(customers.createdAt, createdAt),
      and(eq(customers.createdAt, createdAt), lt(customers.id, id)),
    )!);
  }

  return filters;
}

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

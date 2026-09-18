import type { CustomerListItem, CustomerPage, ListCustomersQuery } from './customer.schema';
import type { Database as Db } from '@/db/client';
import type { RequestAccess } from '@/modules/iam/access.service';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  customerEquipment,
  customers,
  equipment,
  itemCatalog,
  locationPaths as locationPathsView,
  serviceProviders,
  services,
  subscriptions,
  users,
} from '@/db/schema';
import { ERROR_CODES } from '@/errors';
import { badRequest } from '@/errors/domain-error';
import { escapeLike } from '@/utils/search';
import { baseFilters } from './customers.list';

export interface CustomerResultRef extends Record<string, unknown> {
  customerId: string;
  score?: number;
  matchedFields?: string[];
}

interface SearchContext {
  access: RequestAccess;
  query: ListCustomersQuery;
  normalized: string;
}

interface LocatedCustomer { locationId: string | null; locationPath: string | null; locationCodes: string[] }
interface LocatedLine { locationId: string; locationPath: string | null; locationCodes: string[] }

const customerExtraText = sql.raw(`(
  coalesce(c.alternate_phone, '') || ' ' ||
  coalesce(c.whatsapp_number, '') || ' ' ||
  coalesce(c.address, '')
)`);

const subscriptionSearchText = sql.raw(`(
  s.service_account_number || ' ' || coalesce(s.installation_address, '')
)`);

const equipmentSearchText = sql.raw(`(
  coalesce(eq.serial_number, '') || ' ' || coalesce(eq.vc_number, '') || ' ' ||
  coalesce(eq.mac_address, '') || ' ' || coalesce(eq.barcode, '') || ' ' ||
  coalesce(ic.brand, '') || ' ' || coalesce(ic.model, '') || ' ' || coalesce(ic.name, '')
)`);

function normalizeQuery(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized.length === 0)
    throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Search query cannot be empty');

  return normalized;
}

function groupByCustomer<T extends { customerId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows)
    grouped.set(row.customerId, [...(grouped.get(row.customerId) ?? []), row]);
  return grouped;
}

function placeOf(
  person: LocatedCustomer,
  line: LocatedLine | null,
): { locationId: string | null; locationPath: string | null } {
  if (person.locationId !== null && person.locationPath !== null)
    return { locationId: person.locationId, locationPath: person.locationPath };

  return { locationId: line?.locationId ?? null, locationPath: line?.locationPath ?? null };
}

function searchLocations(
  person: LocatedCustomer,
  lines: LocatedLine[],
): NonNullable<CustomerListItem['locations']> {
  const locations = new Map<string, NonNullable<CustomerListItem['locations']>[number]>();
  if (person.locationId !== null && person.locationPath !== null) {
    locations.set(`customer:${person.locationId}`, {
      locationId: person.locationId,
      path: person.locationPath,
      codes: person.locationCodes,
      source: 'customer',
    });
  }
  for (const line of lines) {
    if (line.locationPath !== null) {
      locations.set(`subscription:${line.locationId}`, {
        locationId: line.locationId,
        path: line.locationPath,
        codes: line.locationCodes,
        source: 'subscription',
      });
    }
  }
  return [...locations.values()];
}

function eligibleQuery(db: Db, access: RequestAccess, query: ListCustomersQuery) {
  const filters = baseFilters(db, access, query);
  if (filters === null)
    return null;

  return db.select({ id: customers.id }).from(customers).where(and(...filters));
}

async function candidates(db: Db, context: SearchContext): Promise<CustomerResultRef[]> {
  const { access, query, normalized } = context;
  const eligible = eligibleQuery(db, access, query);
  if (eligible === null)
    return [];

  const escaped = escapeLike(normalized);
  const pattern = `%${escaped}%`;
  const prefix = `${escaped}%`;
  const fuzzy = normalized.length >= 3;
  const digits = normalized.replace(/\D/g, '');
  const alphaNumericLength = normalized.replace(/[^a-z0-9]/g, '').length;
  const numericHeavy = digits.length >= 3 && digits.length / alphaNumericLength >= 0.6;

  const result = await db.execute<CustomerResultRef>(sql`
    WITH eligible AS (${eligible}),
    location_matches AS (
      SELECT l.id,
             CASE
               WHEN lower(l.name) = ${normalized} THEN 0.55
               WHEN l.name ILIKE ${prefix} ESCAPE '\\' THEN 0.50
               ELSE 0.40
             END::real AS score,
             'location.path'::text AS matched_field
      FROM geo.locations l
      WHERE l.tenant_id = ${access.tenantId}
        AND ${fuzzy}
        AND (l.name ILIKE ${pattern} ESCAPE '\\' OR l.name % ${normalized})

      UNION ALL

      SELECT l.id,
             CASE WHEN lower(l.code) = ${normalized} THEN 0.60 ELSE 0.45 END::real,
             'location.code'::text
      FROM geo.locations l
      WHERE l.tenant_id = ${access.tenantId}
        AND l.code IS NOT NULL
        AND (lower(l.code) = ${normalized} OR (${fuzzy} AND l.code ILIKE ${pattern} ESCAPE '\\'))
    ),
    matches AS (
      SELECT e.id AS customer_id,
             CASE
               WHEN lower(c.name) = ${normalized} THEN 1.00
               WHEN c.name ILIKE ${prefix} ESCAPE '\\' THEN 0.94
               WHEN c.name ILIKE ${pattern} ESCAPE '\\' THEN 0.86
               ELSE least(0.90, 0.65 + greatest(similarity(c.name, ${normalized}), word_similarity(${normalized}, c.name)) * 0.25)
             END::real AS score,
             'name'::text AS matched_field
      FROM eligible e
      JOIN crm.customers c ON c.id = e.id
      WHERE c.user_id IS NULL AND c.name IS NOT NULL AND (
        lower(c.name) = ${normalized}
        OR (${fuzzy} AND (c.name ILIKE ${pattern} ESCAPE '\\' OR c.name % ${normalized} OR ${normalized} <% c.name))
      )

      UNION ALL

      SELECT e.id,
             CASE
               WHEN lower(u.name) = ${normalized} THEN 1.00
               WHEN u.name ILIKE ${prefix} ESCAPE '\\' THEN 0.94
               WHEN u.name ILIKE ${pattern} ESCAPE '\\' THEN 0.86
               ELSE least(0.90, 0.65 + greatest(similarity(u.name, ${normalized}), word_similarity(${normalized}, u.name)) * 0.25)
             END::real,
             'name'::text
      FROM eligible e
      JOIN crm.customers c ON c.id = e.id
      JOIN auth.users u ON u.id = c.user_id
      WHERE u.name IS NOT NULL AND (
        lower(u.name) = ${normalized}
        OR (${fuzzy} AND (u.name ILIKE ${pattern} ESCAPE '\\' OR u.name % ${normalized} OR ${normalized} <% u.name))
      )

      UNION ALL

      SELECT e.id,
             CASE WHEN lower(c.phone) = ${normalized} THEN 0.99
                  WHEN c.phone ILIKE ${prefix} ESCAPE '\\' THEN CASE WHEN ${numericHeavy} THEN 0.94 ELSE 0.90 END
                  ELSE CASE WHEN ${numericHeavy} THEN 0.86 ELSE 0.80 END END::real,
             'phone'::text
      FROM eligible e
      JOIN crm.customers c ON c.id = e.id
      WHERE c.user_id IS NULL AND c.phone IS NOT NULL
        AND (lower(c.phone) = ${normalized} OR (${fuzzy} AND c.phone ILIKE ${pattern} ESCAPE '\\'))

      UNION ALL

      SELECT e.id,
             CASE WHEN lower(u.phone) = ${normalized} THEN 0.99
                  WHEN u.phone ILIKE ${prefix} ESCAPE '\\' THEN CASE WHEN ${numericHeavy} THEN 0.94 ELSE 0.90 END
                  ELSE CASE WHEN ${numericHeavy} THEN 0.86 ELSE 0.80 END END::real,
             'phone'::text
      FROM eligible e
      JOIN crm.customers c ON c.id = e.id
      JOIN auth.users u ON u.id = c.user_id
      WHERE u.phone IS NOT NULL
        AND (lower(u.phone) = ${normalized} OR (${fuzzy} AND u.phone ILIKE ${pattern} ESCAPE '\\'))

      UNION ALL

      SELECT e.id,
             CASE WHEN lower(c.customer_code) = ${normalized} THEN 0.99
                  WHEN c.customer_code ILIKE ${prefix} ESCAPE '\\' THEN 0.90
                  ELSE 0.80 END::real,
             'customerCode'::text
      FROM eligible e
      JOIN crm.customers c ON c.id = e.id
      WHERE c.customer_code IS NOT NULL
        AND (lower(c.customer_code) = ${normalized} OR (${fuzzy} AND c.customer_code ILIKE ${pattern} ESCAPE '\\'))

      UNION ALL

      SELECT e.id,
             CASE
               WHEN lower(f.value) = ${normalized} THEN 0.88
               WHEN f.field <> 'address' AND f.value ILIKE ${prefix} ESCAPE '\\' THEN 0.84
               WHEN f.field = 'address' THEN 0.45
               ELSE 0.78
             END::real,
             f.field
      FROM eligible e
      JOIN crm.customers c ON c.id = e.id
      CROSS JOIN LATERAL (VALUES
        ('alternatePhone'::text, c.alternate_phone::text),
        ('whatsappNumber'::text, c.whatsapp_number::text),
        ('address'::text, c.address)
      ) AS f(field, value)
      WHERE c.deleted_at IS NULL
        AND f.value IS NOT NULL
        AND (lower(f.value) = ${normalized} OR (${fuzzy}
          AND ${customerExtraText} ILIKE ${pattern} ESCAPE '\\'
          AND f.value ILIKE ${pattern} ESCAPE '\\'))

      UNION ALL

      SELECT e.id,
             CASE
               WHEN lower(f.value) = ${normalized} THEN CASE WHEN f.field = 'serviceAccountNumber' THEN 0.99 ELSE 0.48 END
               WHEN f.field = 'serviceAccountNumber' AND f.value ILIKE ${prefix} ESCAPE '\\' THEN 0.92
               WHEN f.field = 'serviceAccountNumber' THEN 0.82
               ELSE 0.42
             END::real,
             f.field
      FROM eligible e
      JOIN crm.subscriptions s ON s.customer_id = e.id AND s.tenant_id = ${access.tenantId} AND s.deleted_at IS NULL
      CROSS JOIN LATERAL (VALUES
        ('serviceAccountNumber'::text, s.service_account_number),
        ('installationAddress'::text, s.installation_address)
      ) AS f(field, value)
      WHERE (s.service_account_number = ${normalized} OR (${fuzzy} AND ${subscriptionSearchText} ILIKE ${pattern} ESCAPE '\\'))
        AND f.value IS NOT NULL
        AND (lower(f.value) = ${normalized} OR (${fuzzy} AND f.value ILIKE ${pattern} ESCAPE '\\'))

      UNION ALL

      SELECT e.id,
             CASE
               WHEN lower(f.value) = ${normalized} THEN CASE WHEN f.field IN ('equipment.serialNumber', 'equipment.vcNumber', 'equipment.macAddress', 'equipment.barcode') THEN 0.98 ELSE 0.55 END
               WHEN f.field IN ('equipment.serialNumber', 'equipment.vcNumber', 'equipment.macAddress', 'equipment.barcode')
                 AND f.value ILIKE ${prefix} ESCAPE '\\' THEN 0.90
               WHEN f.field IN ('equipment.serialNumber', 'equipment.vcNumber', 'equipment.macAddress', 'equipment.barcode') THEN 0.80
               ELSE 0.45
             END::real,
             f.field
      FROM eligible e
      JOIN inventory.customer_equipment ce ON ce.customer_id = e.id AND ce.tenant_id = ${access.tenantId}
      JOIN inventory.equipment eq ON eq.id = ce.equipment_id AND eq.tenant_id = ${access.tenantId}
      LEFT JOIN inventory.item_catalog ic ON ic.id = eq.catalog_id
      CROSS JOIN LATERAL (VALUES
        ('equipment.serialNumber'::text, eq.serial_number),
        ('equipment.vcNumber'::text, eq.vc_number),
        ('equipment.macAddress'::text, eq.mac_address),
        ('equipment.barcode'::text, eq.barcode),
        ('equipment.brand'::text, ic.brand),
        ('equipment.model'::text, ic.model),
        ('equipment.type'::text, ic.name)
      ) AS f(field, value)
      WHERE f.value IS NOT NULL
        AND (lower(f.value) = ${normalized} OR (${fuzzy}
          AND ${equipmentSearchText} ILIKE ${pattern} ESCAPE '\\'
          AND f.value ILIKE ${pattern} ESCAPE '\\'))

      UNION ALL

      SELECT e.id, lm.score, lm.matched_field
      FROM location_matches lm
      CROSS JOIN LATERAL geo.location_descendants(lm.id) d
      JOIN crm.subscriptions s ON s.installation_location_id = d.id AND s.tenant_id = ${access.tenantId} AND s.deleted_at IS NULL
      JOIN eligible e ON e.id = s.customer_id
    )
    SELECT customer_id AS "customerId",
           max(score)::real AS score,
           array_agg(DISTINCT matched_field ORDER BY matched_field) AS "matchedFields"
    FROM matches
    GROUP BY customer_id
    ORDER BY max(score) DESC, customer_id
    LIMIT ${query.limit}
  `);

  return result.rows;
}

export async function hydrateCustomerItems(
  db: Db,
  access: RequestAccess,
  ranked: CustomerResultRef[],
): Promise<CustomerListItem[]> {
  if (ranked.length === 0)
    return [];

  const ids = ranked.map(row => row.customerId);
  const [people, lines, kit] = await Promise.all([
    db.select({
      id: customers.id,
      customerCode: customers.customerCode,
      name: sql<string | null>`coalesce(${users.name}, ${customers.name})`,
      phone: sql<string | null>`coalesce(${users.phone}, ${customers.phone})`,
      alternatePhone: customers.alternatePhone,
      whatsappNumber: customers.whatsappNumber,
      status: customers.status,
      address: customers.address,
      outstandingBalance: customers.outstandingBalance,
      locationId: sql<string | null>`null`,
      locationPath: sql<string | null>`null`,
      locationCodes: sql<string[]>`ARRAY[]::text[]`,
      createdAt: customers.createdAt,
    })
      .from(customers)
      .leftJoin(users, eq(users.id, customers.userId))
      .where(and(eq(customers.tenantId, access.tenantId), inArray(customers.id, ids))),
    db.select({
      customerId: subscriptions.customerId,
      subscriptionId: subscriptions.id,
      accountNumber: subscriptions.serviceAccountNumber,
      installationAddress: subscriptions.installationAddress,
      locationId: subscriptions.installationLocationId,
      locationPath: locationPathsView.path,
      locationCodes: sql<string[]>`coalesce(${locationPathsView.codes}, ARRAY[]::text[])`,
      status: subscriptions.status,
      service: services.name,
    })
      .from(subscriptions)
      .innerJoin(serviceProviders, eq(serviceProviders.id, subscriptions.serviceProviderId))
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .leftJoin(locationPathsView, and(
        eq(locationPathsView.id, subscriptions.installationLocationId),
        eq(locationPathsView.tenantId, access.tenantId),
      ))
      .where(and(
        eq(subscriptions.tenantId, access.tenantId),
        inArray(subscriptions.customerId, ids),
        isNull(subscriptions.deletedAt),
      )),
    db.select({
      customerId: customerEquipment.customerId,
      id: equipment.id,
      subscriptionId: customerEquipment.subscriptionId,
      type: sql<string>`coalesce(${itemCatalog.name}, 'Equipment')`.as('type'),
      brand: itemCatalog.brand,
      model: itemCatalog.model,
      serialNumber: equipment.serialNumber,
      vcNumber: equipment.vcNumber,
      macAddress: equipment.macAddress,
      barcode: equipment.barcode,
      status: customerEquipment.status,
    })
      .from(customerEquipment)
      .innerJoin(equipment, and(
        eq(equipment.id, customerEquipment.equipmentId),
        eq(equipment.tenantId, access.tenantId),
      ))
      .leftJoin(itemCatalog, eq(itemCatalog.id, equipment.catalogId))
      .where(and(
        eq(customerEquipment.tenantId, access.tenantId),
        inArray(customerEquipment.customerId, ids),
      )),
  ]);

  const personById = new Map(people.map(row => [row.id, row]));
  const linesById = groupByCustomer(lines);
  const kitById = groupByCustomer(kit);
  return ranked.flatMap((rank) => {
    const person = personById.get(rank.customerId);
    if (person === undefined)
      return [];

    const serviceAccounts = linesById.get(person.id) ?? [];
    const activeLines = serviceAccounts.filter(line => line.status === 'active');
    const place = placeOf(person, activeLines[0] ?? serviceAccounts[0] ?? null);
    const searchMetadata = rank.score === undefined
      ? {}
      : {
          matchedFields: rank.matchedFields ?? [],
          score: Math.min(1, Math.max(0, Number(rank.score.toFixed(4)))),
        };
    return [{
      id: person.id,
      customerCode: person.customerCode,
      name: person.name,
      phone: person.phone,
      alternatePhone: person.alternatePhone,
      whatsappNumber: person.whatsappNumber,
      status: person.status,
      address: person.address,
      outstandingBalance: person.outstandingBalance,
      locationId: place.locationId,
      locationPath: place.locationPath,
      subscriptions: serviceAccounts.length,
      activeSubscriptions: activeLines.length,
      services: [...new Set(activeLines.map(line => line.service))].sort(),
      createdAt: person.createdAt.toISOString(),
      locations: searchLocations(person, serviceAccounts),
      serviceAccounts: serviceAccounts.map(({
        customerId: _,
        status: _status,
        locationCodes: _locationCodes,
        ...line
      }) => line),
      equipment: (kitById.get(person.id) ?? []).map(({ customerId: _, ...item }) => item),
      ...searchMetadata,
    }];
  });
}

export async function searchCustomers(
  db: Db,
  access: RequestAccess,
  query: ListCustomersQuery,
): Promise<CustomerPage> {
  const normalized = normalizeQuery(query.q!);
  const ranked = await candidates(db, { access, query, normalized });
  const items = await hydrateCustomerItems(db, access, ranked);

  return { items, total: items.length, limit: query.limit, nextCursor: null };
}

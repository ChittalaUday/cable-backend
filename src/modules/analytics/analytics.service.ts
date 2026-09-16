import type { SQL } from 'drizzle-orm';
import type { AdminDashboard, StaffCollectionMetrics, StaffDashboard } from './analytics.schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { Database } from '@/plugins/database';
import type { CustomerStatus } from '@/shared/constants/crm';
import { sql } from 'drizzle-orm';
import { SYSTEM_ROLES } from '@/config/constants';
import { customerWithinNodes } from '@/modules/customers/customers.service';
import { ERROR_CODES } from '@/shared/errors';
import { forbidden } from '@/shared/errors/domain-error';
import { withinGrantedSubtree } from '@/shared/security/location-scope';

type CountRow = Record<string, string | number | null>;
interface BarRow extends Record<string, unknown> { key: string; label: string; value: string }

const number = (value: string | number | null | undefined) => Number(value ?? 0);
const money = (value: string | number | null | undefined) => number(value).toFixed(2);
const iso = (value: Date | string) => new Date(value instanceof Date ? value.getTime() : value).toISOString();
const share = (count: number, total: number) => total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
const growth = (current: number, previous: number) => previous > 0 ? ((current - previous) / previous) * 100 : null;

function boundaries(now: Date) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(day);
  week.setDate(day.getDate() - day.getDay());
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { day, week, month, previousMonth };
}

export class AnalyticsService {
  constructor(private readonly db: Database) {}

  async adminDashboard(access: RequestAccess, now = new Date()): Promise<AdminDashboard> {
    if (access.roleId !== SYSTEM_ROLES.ADMIN)
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'Admin dashboard requires the admin role');

    const { day, week, month, previousMonth } = boundaries(now);
    const tenantId = access.tenantId;
    const [customerResult, connectionResult, servicesResult, areasResult, recentResult, activityResult, collectionResult, daily, weekly, monthly] = await Promise.all([
      this.db.execute<CountRow>(sql`
        SELECT count(*)::int total,
          count(*) FILTER (WHERE status = 'active')::int active,
          count(*) FILTER (WHERE status = 'inactive')::int inactive,
          count(*) FILTER (WHERE status = 'pending')::int pending,
          count(*) FILTER (WHERE created_at >= ${month})::int current_added,
          count(*) FILTER (WHERE created_at >= ${previousMonth} AND created_at < ${month})::int previous_added,
          coalesce(sum(outstanding_balance) FILTER (WHERE outstanding_balance > 0), 0) outstanding,
          count(*) FILTER (WHERE outstanding_balance > 0)::int due_accounts
        FROM crm.customers WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      `),
      this.db.execute<CountRow>(sql`
        SELECT count(*)::int total,
          count(*) FILTER (WHERE status = 'active')::int active,
          count(*) FILTER (WHERE status = 'inactive')::int inactive,
          count(*) FILTER (WHERE status = 'suspended')::int suspended,
          count(*) FILTER (WHERE status = 'cancelled')::int cancelled,
          count(*) FILTER (WHERE start_date >= ${month})::int current_added,
          count(*) FILTER (WHERE start_date >= ${previousMonth} AND start_date < ${month})::int previous_added
        FROM crm.subscriptions WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      `),
      this.db.execute<{ id: string; label: string; count: number }>(sql`
        SELECT s.id, s.name label, count(*)::int count
        FROM crm.subscriptions sub
        JOIN crm.service_providers sp ON sp.id = sub.service_provider_id
        JOIN crm.services s ON s.id = sp.service_id
        WHERE sub.tenant_id = ${tenantId} AND sub.deleted_at IS NULL
        GROUP BY s.id, s.name ORDER BY count(*) DESC, s.name
      `),
      this.db.execute<{ id: string; name: string; count: number }>(sql`
        SELECT lp.id, lp.path name, count(*)::int count
        FROM crm.subscriptions sub JOIN geo.location_paths lp ON lp.id = sub.location_id
        WHERE sub.tenant_id = ${tenantId} AND sub.deleted_at IS NULL
        GROUP BY lp.id, lp.path ORDER BY count(*) DESC, lp.path LIMIT 5
      `),
      this.db.execute<{ id: string; name: string | null; phone: string | null; status: CustomerStatus; createdAt: Date | string; connectionCount: number }>(sql`
        SELECT c.id, coalesce(u.name, c.name) name, coalesce(u.phone, c.phone) phone, c.status,
          c.created_at "createdAt", count(sub.id)::int "connectionCount"
        FROM crm.customers c LEFT JOIN auth.users u ON u.id = c.user_id
        LEFT JOIN crm.subscriptions sub ON sub.customer_id = c.id AND sub.deleted_at IS NULL
        WHERE c.tenant_id = ${tenantId} AND c.deleted_at IS NULL
        GROUP BY c.id, u.name, u.phone ORDER BY c.created_at DESC LIMIT 4
      `),
      this.db.execute<{ id: string; kind: 'customer' | 'payment'; title: string; subtitle: string; createdAt: Date | string }>(sql`
        SELECT id::text, 'customer'::text kind, coalesce(name, customer_code, 'Customer') title,
          'Customer added'::text subtitle, created_at "createdAt" FROM crm.customers
        WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
        UNION ALL
        SELECT id::text, 'payment'::text, transaction_no, service_account_number,
          transaction_date FROM crm.account_transactions
        WHERE tenant_id = ${tenantId} AND transaction_type = 'deposit' AND credit > 0
        ORDER BY "createdAt" DESC LIMIT 6
      `),
      this.collectionMetrics(sql`tenant_id = ${tenantId}`, { day, week, month }),
      this.collectionSeries(tenantId, now, 'day'),
      this.collectionSeries(tenantId, now, 'week'),
      this.collectionSeries(tenantId, now, 'month'),
    ]);

    const customers = customerResult.rows[0] ?? {};
    const connections = connectionResult.rows[0] ?? {};
    const serviceTotal = servicesResult.rows.reduce((sum, row) => sum + number(row.count), 0);
    const areaTotal = areasResult.rows.reduce((sum, row) => sum + number(row.count), 0);
    const customerTotal = number(customers.total);
    const connectionTotal = number(connections.total);

    return {
      customers: {
        total: customerTotal,
        active: number(customers.active),
        inactive: number(customers.inactive),
        pending: number(customers.pending),
        delta: growth(number(customers.current_added), number(customers.previous_added)),
        series: await this.cumulativeSeries(tenantId, now, { table: 'crm.customers', dateColumn: 'created_at' }),
      },
      connections: {
        total: connectionTotal,
        active: number(connections.active),
        inactive: number(connections.inactive),
        suspended: number(connections.suspended),
        cancelled: number(connections.cancelled),
        delta: growth(number(connections.current_added), number(connections.previous_added)),
        series: await this.cumulativeSeries(tenantId, now, { table: 'crm.subscriptions', dateColumn: 'start_date' }),
      },
      collections: {
        ...collectionResult,
        delta: growth(number(collectionResult.month), number(monthly.rows.at(-2)?.value)),
        series: { daily: daily.rows, weekly: weekly.rows, monthly: monthly.rows },
      },
      outstanding: { amount: money(customers.outstanding), accounts: number(customers.due_accounts) },
      services: servicesResult.rows.map(row => ({ ...row, count: number(row.count), share: share(number(row.count), serviceTotal) })),
      areas: areasResult.rows.map(row => ({ ...row, count: number(row.count), share: share(number(row.count), areaTotal) })),
      recentCustomers: recentResult.rows.map(row => ({ ...row, name: row.name ?? 'Customer', phone: row.phone ?? '', createdAt: iso(row.createdAt) })),
      activity: activityResult.rows.map(row => ({ ...row, createdAt: iso(row.createdAt) })),
      generatedAt: now.toISOString(),
    };
  }

  async staffDashboard(access: RequestAccess, now = new Date()): Promise<StaffDashboard> {
    if (access.roleId !== SYSTEM_ROLES.STAFF)
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'Staff dashboard requires the staff role');

    const periods = boundaries(now);
    const [membership] = (await this.db.execute<{ teamId: string | null }>(sql`
      SELECT team_id "teamId" FROM tenancy.tenant_memberships WHERE id = ${access.membershipId}
    `)).rows;
    const teamId = membership?.teamId ?? null;
    const personalFilter = sql`t.tenant_id = ${access.tenantId} AND t.collected_by = ${access.userId}`;
    const teamFilter = teamId === null
      ? null
      : sql`t.tenant_id = ${access.tenantId} AND EXISTS (
      SELECT 1 FROM tenancy.tenant_memberships m
      WHERE m.user_id = t.collected_by AND m.tenant_id = t.tenant_id AND m.team_id = ${teamId} AND m.status = 'active'
    )`;

    const [personal, team, workloadResult, recentResult] = await Promise.all([
      this.collectionMetrics(personalFilter, periods, 't'),
      teamFilter === null ? Promise.resolve(null) : this.collectionMetrics(teamFilter, periods, 't'),
      this.staffWorkload(access),
      this.db.execute<{ id: string; customerId: string | null; customerName: string | null; accountNumber: string; amount: string; collectedAt: Date | string }>(sql`
        SELECT t.id, t.customer_id "customerId", coalesce(u.name, c.name) "customerName",
          t.service_account_number "accountNumber", t.credit amount, t.transaction_date "collectedAt"
        FROM crm.account_transactions t LEFT JOIN crm.customers c ON c.id = t.customer_id
        LEFT JOIN auth.users u ON u.id = c.user_id
        WHERE ${personalFilter} AND t.transaction_type = 'deposit' AND t.credit > 0
        ORDER BY t.transaction_date DESC LIMIT 10
      `),
    ]);

    return {
      personal,
      team,
      workload: workloadResult,
      recentCollections: recentResult.rows.map(row => ({ ...row, amount: money(row.amount), collectedAt: iso(row.collectedAt) })),
      generatedAt: now.toISOString(),
    };
  }

  private async collectionMetrics(filter: SQL, periods: Pick<ReturnType<typeof boundaries>, 'day' | 'week' | 'month'>, alias = ''): Promise<StaffCollectionMetrics> {
    const prefix = alias ? sql.raw(`${alias}.`) : sql.empty();
    const result = await this.db.execute<CountRow>(sql`
      SELECT
        coalesce(sum(${prefix}credit) FILTER (WHERE ${prefix}transaction_date >= ${periods.day}), 0) "today",
        coalesce(sum(${prefix}credit) FILTER (WHERE ${prefix}transaction_date >= ${periods.week}), 0) "week",
        coalesce(sum(${prefix}credit) FILTER (WHERE ${prefix}transaction_date >= ${periods.month}), 0) "month",
        count(*) FILTER (WHERE ${prefix}transaction_date >= ${periods.day})::int "today_receipts",
        count(*) FILTER (WHERE ${prefix}transaction_date >= ${periods.week})::int "week_receipts",
        count(*) FILTER (WHERE ${prefix}transaction_date >= ${periods.month})::int "month_receipts"
      FROM crm.account_transactions ${alias ? sql.raw(alias) : sql.empty()}
      WHERE ${filter} AND ${prefix}transaction_type = 'deposit' AND ${prefix}credit > 0
    `);
    const row = result.rows[0] ?? {};
    return {
      today: money(row.today),
      week: money(row.week),
      month: money(row.month),
      todayReceipts: number(row.today_receipts),
      weekReceipts: number(row.week_receipts),
      monthReceipts: number(row.month_receipts),
    };
  }

  private async collectionSeries(tenantId: string, now: Date, unit: 'day' | 'week' | 'month') {
    const steps = unit === 'day' ? 8 : unit === 'week' ? 8 : 8;
    const format = unit === 'day' ? 'FMDD' : unit === 'week' ? 'DD Mon' : 'Mon';
    return this.db.execute<BarRow>(sql`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc(${unit}, ${now}::timestamptz) - (${steps} || ' ${sql.raw(unit)}s')::interval,
          date_trunc(${unit}, ${now}::timestamptz), '1 ${sql.raw(unit)}'::interval
        ) bucket
      )
      SELECT to_char(bucket, 'YYYY-MM-DD') key, to_char(bucket, ${format}) label,
        coalesce(sum(t.credit), 0)::numeric(12,2)::text value
      FROM buckets LEFT JOIN crm.account_transactions t
        ON t.tenant_id = ${tenantId} AND t.transaction_type = 'deposit' AND t.credit > 0
        AND t.transaction_date >= bucket AND t.transaction_date < bucket + '1 ${sql.raw(unit)}'::interval
      GROUP BY bucket ORDER BY bucket
    `);
  }

  private async cumulativeSeries(tenantId: string, now: Date, source: {
    table: 'crm.customers' | 'crm.subscriptions';
    dateColumn: 'created_at' | 'start_date';
  }) {
    const result = await this.db.execute<{ count: number }>(sql`
      WITH buckets AS (
        SELECT generate_series(date_trunc('month', ${now}::timestamptz) - interval '7 months', date_trunc('month', ${now}::timestamptz), interval '1 month') bucket
      )
      SELECT count(t.*)::int count FROM buckets b LEFT JOIN ${sql.raw(source.table)} t
        ON t.tenant_id = ${tenantId} AND t.deleted_at IS NULL AND t.${sql.raw(source.dateColumn)} < b.bucket + interval '1 month'
      GROUP BY b.bucket ORDER BY b.bucket
    `);
    return result.rows.map(row => number(row.count));
  }

  private async staffWorkload(access: RequestAccess): Promise<StaffDashboard['workload']> {
    if (access.locationIds.length === 0)
      return { customers: 0, dueCustomers: 0, outstanding: '0.00', activeConnections: 0, inactiveConnections: 0 };

    const reachesCustomer = customerWithinNodes(access.locationIds, {
      id: sql`c.id`,
      locationId: sql`c.location_id`,
    });

    const result = await this.db.execute<CountRow>(sql`
      WITH visible_customers AS (
        SELECT DISTINCT c.id, c.outstanding_balance
        FROM crm.customers c
        WHERE c.tenant_id = ${access.tenantId} AND c.deleted_at IS NULL AND ${reachesCustomer}
      ), visible_connections AS (
        SELECT DISTINCT s.id, s.status FROM crm.subscriptions s
        WHERE s.tenant_id = ${access.tenantId} AND s.deleted_at IS NULL
          AND ${withinGrantedSubtree(sql`s.location_id`, access.locationIds)}
      )
      SELECT (SELECT count(*) FROM visible_customers)::int customers,
        (SELECT count(*) FROM visible_customers WHERE outstanding_balance > 0)::int due_customers,
        (SELECT coalesce(sum(outstanding_balance), 0) FROM visible_customers WHERE outstanding_balance > 0) outstanding,
        (SELECT count(*) FROM visible_connections WHERE status = 'active')::int active_connections,
        (SELECT count(*) FROM visible_connections WHERE status <> 'active')::int inactive_connections
    `);
    const row = result.rows[0] ?? {};
    return {
      customers: number(row.customers),
      dueCustomers: number(row.due_customers),
      outstanding: money(row.outstanding),
      activeConnections: number(row.active_connections),
      inactiveConnections: number(row.inactive_connections),
    };
  }
}

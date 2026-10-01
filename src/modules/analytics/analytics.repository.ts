import type { SQL } from 'drizzle-orm';
import type { CustomerStatus } from '@/constants/crm';
import type { Database } from '@/db/client';
import { sql } from 'drizzle-orm';
import { customerWithinNodes } from '@/modules/customers/customer.service';
import { withinGrantedSubtree } from '@/security/location-scope';

export type CountRow = Record<string, string | number | null>;

export interface BarRow extends Record<string, unknown> {
  key: string;
  label: string;
  value: string;
}

export interface Periods {
  day: Date;
  week: Date;
  month: Date;
}

export interface ServiceCountRow extends Record<string, unknown> { id: string; label: string; count: number }
export interface AreaCountRow extends Record<string, unknown> { id: string; name: string; count: number }

export interface RecentCustomerRow extends Record<string, unknown> {
  id: string;
  name: string | null;
  phone: string | null;
  status: CustomerStatus;
  createdAt: Date | string;
  connectionCount: number;
}

export interface ActivityRow extends Record<string, unknown> {
  id: string;
  kind: 'customer' | 'payment';
  title: string;
  subtitle: string;
  createdAt: Date | string;
}

export interface StaffRow extends Record<string, unknown> {
  id: string;
  name: string | null;
  collected: string;
  receipts: number;
  lastCollectedAt: Date | string | null;
}

export interface RecentCollectionRow extends Record<string, unknown> {
  id: string;
  customerId: string | null;
  customerName: string | null;
  accountNumber: string;
  amount: string;
  collectedAt: Date | string;
}

const CASH_MOVEMENTS = ['deposit', 'reversal'];

/**
 * Every real collection, plus pre-receipt ledger rows kept for migrated data.
 * A linked ledger row is deliberately excluded: `billing.collections` carries
 * the full amount including equipment and accessories, while the ledger only
 * carries the portion that changed subscription dues.
 */
function cashEvents(): SQL {
  return sql`
    SELECT c.id, c.tenant_id, c.customer_id, c.collected_by,
      c.total_collected amount,
      CASE WHEN c.outcome = 'refund' THEN -1 WHEN c.outcome = 'none' OR c.total_collected = 0 THEN 0 ELSE 1 END receipt_delta,
      c.collected_at occurred_at,
      coalesce(s.service_account_number, 'Equipment') account_number
    FROM billing.collections c
    LEFT JOIN crm.subscriptions s ON s.id = c.subscription_id
    UNION ALL
    SELECT t.id, t.tenant_id, t.customer_id, t.collected_by,
      t.credit - t.debit amount,
      CASE WHEN t.transaction_type = 'reversal' THEN -1 ELSE 1 END receipt_delta,
      t.transaction_date occurred_at,
      t.service_account_number account_number
    FROM crm.account_transactions t
    WHERE t.transaction_type = ANY(${sql.param(CASH_MOVEMENTS)}::text[])
      AND NOT EXISTS (SELECT 1 FROM billing.collections c WHERE c.transaction_id = t.id)
  `;
}

export class AnalyticsRepository {
  constructor(private readonly db: Database) {}

  get database(): Database {
    return this.db;
  }

  async customerTotals(tenantId: string, month: Date): Promise<CountRow> {
    const result = await this.db.execute<CountRow>(sql`
      SELECT count(*)::int total,
        count(*) FILTER (WHERE status = 'active')::int active,
        count(*) FILTER (WHERE status = 'inactive')::int inactive,
        count(*) FILTER (WHERE status = 'pending')::int pending,
        count(*) FILTER (WHERE created_at >= ${month})::int current_added,
        coalesce(sum(outstanding_balance) FILTER (WHERE outstanding_balance > 0), 0) outstanding,
        count(*) FILTER (WHERE outstanding_balance > 0)::int due_accounts
      FROM crm.customers WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    `);

    return result.rows[0] ?? {};
  }

  async connectionTotals(tenantId: string, month: Date, previousMonth: Date): Promise<CountRow> {
    const result = await this.db.execute<CountRow>(sql`
      SELECT count(*)::int total,
        count(*) FILTER (WHERE status = 'active')::int active,
        count(*) FILTER (WHERE status = 'inactive')::int inactive,
        count(*) FILTER (WHERE status = 'suspended')::int suspended,
        count(*) FILTER (WHERE status = 'cancelled')::int cancelled,
        count(*) FILTER (WHERE start_date >= ${month})::int current_added,
        count(*) FILTER (WHERE end_date >= ${month})::int current_ended,
        count(*) FILTER (WHERE end_date >= ${previousMonth} AND end_date < ${month})::int previous_ended
      FROM crm.subscriptions WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    `);

    return result.rows[0] ?? {};
  }

  async subscriptionsByService(tenantId: string): Promise<ServiceCountRow[]> {
    const result = await this.db.execute<ServiceCountRow>(sql`
      SELECT s.id, s.name label, count(*)::int count
      FROM crm.subscriptions sub
      JOIN crm.service_providers sp ON sp.id = sub.service_provider_id
      JOIN crm.services s ON s.id = sp.service_id
      WHERE sub.tenant_id = ${tenantId} AND sub.deleted_at IS NULL
      GROUP BY s.id, s.name ORDER BY count(*) DESC, s.name
    `);

    return result.rows;
  }

  async subscriptionsByArea(tenantId: string, limit: number): Promise<AreaCountRow[]> {
    const result = await this.db.execute<AreaCountRow>(sql`
      SELECT lp.id, lp.path name, count(*)::int count
      FROM crm.subscriptions sub JOIN geo.location_paths lp ON lp.id = sub.installation_location_id
      WHERE sub.tenant_id = ${tenantId} AND sub.deleted_at IS NULL
      GROUP BY lp.id, lp.path ORDER BY count(*) DESC, lp.path LIMIT ${limit}
    `);

    return result.rows;
  }

  async recentCustomers(tenantId: string, limit: number): Promise<RecentCustomerRow[]> {
    const result = await this.db.execute<RecentCustomerRow>(sql`
      SELECT c.id, coalesce(u.name, c.name) name, coalesce(u.phone, c.phone) phone, c.status,
        c.created_at "createdAt", count(sub.id)::int "connectionCount"
      FROM crm.customers c LEFT JOIN auth.users u ON u.id = c.user_id
      LEFT JOIN crm.subscriptions sub ON sub.customer_id = c.id AND sub.deleted_at IS NULL
      WHERE c.tenant_id = ${tenantId} AND c.deleted_at IS NULL
      GROUP BY c.id, u.name, u.phone ORDER BY c.created_at DESC LIMIT ${limit}
    `);

    return result.rows;
  }

  async recentActivity(tenantId: string, limit: number): Promise<ActivityRow[]> {
    const result = await this.db.execute<ActivityRow>(sql`
      SELECT id::text, 'customer'::text kind, coalesce(name, customer_code, 'Customer') title,
        'Customer added'::text subtitle, created_at "createdAt" FROM crm.customers
      WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
      UNION ALL
      SELECT t.id::text, 'payment'::text, coalesce(u.name, c.name, c.customer_code, 'Payment'),
        t.account_number, t.occurred_at
      FROM (${cashEvents()}) t
      LEFT JOIN crm.customers c ON c.id = t.customer_id
      LEFT JOIN auth.users u ON u.id = c.user_id
      WHERE t.tenant_id = ${tenantId} AND t.amount > 0 AND t.receipt_delta > 0
      ORDER BY "createdAt" DESC LIMIT ${limit}
    `);

    return result.rows;
  }

  tenantFilter(tenantId: string): SQL {
    return sql`t.tenant_id = ${tenantId}`;
  }

  collectorFilter(tenantId: string, userId: string): SQL {
    return sql`t.tenant_id = ${tenantId} AND t.collected_by = ${userId}`;
  }

  teamFilter(tenantId: string, teamId: string): SQL {
    return sql`t.tenant_id = ${tenantId} AND EXISTS (
      SELECT 1 FROM tenancy.tenant_memberships m
      WHERE m.user_id = t.collected_by AND m.tenant_id = t.tenant_id
        AND m.team_id = ${teamId} AND m.status = 'active' AND m.deleted_at IS NULL
    )`;
  }

  async collectionMetrics(filter: SQL, periods: Periods): Promise<CountRow> {
    const result = await this.db.execute<CountRow>(sql`
      SELECT
        coalesce(sum(t.amount) FILTER (WHERE t.occurred_at >= ${periods.day}), 0) "today",
        coalesce(sum(t.amount) FILTER (WHERE t.occurred_at >= ${periods.week}), 0) "week",
        coalesce(sum(t.amount) FILTER (WHERE t.occurred_at >= ${periods.month}), 0) "month",
        coalesce(sum(t.receipt_delta) FILTER (WHERE t.occurred_at >= ${periods.day}), 0)::int "today_receipts",
        coalesce(sum(t.receipt_delta) FILTER (WHERE t.occurred_at >= ${periods.week}), 0)::int "week_receipts",
        coalesce(sum(t.receipt_delta) FILTER (WHERE t.occurred_at >= ${periods.month}), 0)::int "month_receipts"
      FROM (${cashEvents()}) t
      WHERE ${filter}
    `);

    return result.rows[0] ?? {};
  }

  async collectionSeries(tenantId: string, now: Date, unit: 'day' | 'week' | 'month', steps: number): Promise<BarRow[]> {
    const format = unit === 'day' ? 'FMDD' : unit === 'week' ? 'DD Mon' : 'Mon';

    const result = await this.db.execute<BarRow>(sql`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc(${unit}, ${now}::timestamptz) - (${steps} || ' ${sql.raw(unit)}s')::interval,
          date_trunc(${unit}, ${now}::timestamptz), '1 ${sql.raw(unit)}'::interval
        ) bucket
      )
      SELECT to_char(bucket, 'YYYY-MM-DD') key, to_char(bucket, ${format}) label,
        coalesce(sum(t.amount), 0)::numeric(12,2)::text value
      FROM buckets LEFT JOIN (${cashEvents()}) t
        ON t.tenant_id = ${tenantId}
        AND t.occurred_at >= bucket AND t.occurred_at < bucket + '1 ${sql.raw(unit)}'::interval
      GROUP BY bucket ORDER BY bucket
    `);

    return result.rows;
  }

  async cumulativeSeries(tenantId: string, now: Date, source: {
    table: 'crm.customers' | 'crm.subscriptions';
    dateColumn: 'created_at' | 'start_date' | 'end_date';
  }, months: number): Promise<number[]> {
    const result = await this.db.execute<{ count: number }>(sql`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc('month', ${now}::timestamptz) - (${months} || ' months')::interval,
          date_trunc('month', ${now}::timestamptz), interval '1 month'
        ) bucket
      )
      SELECT count(t.*)::int count FROM buckets b LEFT JOIN ${sql.raw(source.table)} t
        ON t.tenant_id = ${tenantId} AND t.deleted_at IS NULL AND t.${sql.raw(source.dateColumn)} < b.bucket + interval '1 month'
      GROUP BY b.bucket ORDER BY b.bucket
    `);

    return result.rows.map(row => Number(row.count));
  }

  /** The caller's team, read back under their own tenant — never by id alone. */
  async staffWorkload(tenantId: string, nodeIds: readonly string[]): Promise<CountRow> {
    const reachesCustomer = customerWithinNodes(nodeIds, { id: sql`c.id` });

    const result = await this.db.execute<CountRow>(sql`
      WITH visible_customers AS (
        SELECT DISTINCT c.id, c.outstanding_balance
        FROM crm.customers c
        WHERE c.tenant_id = ${tenantId} AND c.deleted_at IS NULL AND ${reachesCustomer}
      ), visible_connections AS (
        SELECT DISTINCT s.id, s.status FROM crm.subscriptions s
        WHERE s.tenant_id = ${tenantId} AND s.deleted_at IS NULL
          AND ${withinGrantedSubtree(sql`s.installation_location_id`, nodeIds)}
      )
      SELECT (SELECT count(*) FROM visible_customers)::int customers,
        (SELECT count(*) FROM visible_customers WHERE outstanding_balance > 0)::int due_customers,
        (SELECT coalesce(sum(outstanding_balance), 0) FROM visible_customers WHERE outstanding_balance > 0) outstanding,
        (SELECT count(*) FROM visible_connections WHERE status = 'active')::int active_connections,
        (SELECT count(*) FROM visible_connections WHERE status <> 'active')::int inactive_connections
    `);

    return result.rows[0] ?? {};
  }

  /**
   * Who collected what, this period.
   *
   * Keyed on the collector rather than on staff records, so somebody who has
   * taken no money simply is not here — a roster of idle names is the staff
   * screen's job, not the dashboard's.
   */
  async staffLeaderboard(tenantId: string, since: Date, limit: number): Promise<StaffRow[]> {
    const result = await this.db.execute<StaffRow>(sql`
      SELECT u.id, coalesce(u.name, u.phone, u.email) name,
        coalesce(sum(t.amount), 0)::numeric(12,2)::text collected,
        coalesce(sum(t.receipt_delta), 0)::int receipts,
        max(t.occurred_at) "lastCollectedAt"
      FROM (${cashEvents()}) t JOIN auth.users u ON u.id = t.collected_by
      WHERE t.tenant_id = ${tenantId} AND t.occurred_at >= ${since}
      GROUP BY u.id, u.name, u.phone, u.email
      HAVING coalesce(sum(t.receipt_delta), 0) > 0
      ORDER BY sum(t.amount) DESC, u.id LIMIT ${limit}
    `);

    return result.rows;
  }

  async recentCollections(filter: SQL, limit: number): Promise<RecentCollectionRow[]> {
    const result = await this.db.execute<RecentCollectionRow>(sql`
      SELECT t.id, t.customer_id "customerId", coalesce(u.name, c.name) "customerName",
        t.account_number "accountNumber", t.amount, t.occurred_at "collectedAt"
      FROM (${cashEvents()}) t LEFT JOIN crm.customers c ON c.id = t.customer_id
      LEFT JOIN auth.users u ON u.id = c.user_id
      WHERE ${filter} AND t.amount > 0 AND t.receipt_delta > 0
      ORDER BY t.occurred_at DESC LIMIT ${limit}
    `);

    return result.rows;
  }
}

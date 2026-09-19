import type { CountRow, Periods } from './analytics.repository';
import type { AdminDashboard, StaffCollectionMetrics, StaffDashboard } from './analytics.schema';
import type { Database } from '@/db/client';
import type { RequestAccess } from '@/modules/iam/access.service';
import { ERROR_CODES } from '@/errors';
import { forbidden } from '@/errors/domain-error';
import { requireScope } from '@/modules/iam/access.service';
import { PERMISSIONS } from '@/security/permissions';
import { AnalyticsRepository } from './analytics.repository';

const number = (value: string | number | null | undefined) => Number(value ?? 0);
const money = (value: string | number | null | undefined) => number(value).toFixed(2);
const iso = (value: Date | string) => new Date(value instanceof Date ? value.getTime() : value).toISOString();
const share = (count: number, total: number) => total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
const growth = (current: number, previous: number) => previous > 0 ? ((current - previous) / previous) * 100 : null;

const SERIES_STEPS = 8;
const SERIES_MONTHS = 7;
const TOP_AREAS = 5;
const RECENT_CUSTOMERS = 4;
const RECENT_ACTIVITY = 6;
const RECENT_COLLECTIONS = 10;

function boundaries(now: Date): Periods & { previousMonth: Date } {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(day);
  week.setDate(day.getDate() - day.getDay());
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { day, week, month, previousMonth };
}

function toMetrics(row: CountRow): StaffCollectionMetrics {
  return {
    today: money(row.today),
    week: money(row.week),
    month: money(row.month),
    todayReceipts: number(row.today_receipts),
    weekReceipts: number(row.week_receipts),
    monthReceipts: number(row.month_receipts),
  };
}

export class AnalyticsService {
  private readonly repo: AnalyticsRepository;

  constructor(repoOrDb: AnalyticsRepository | Database) {
    this.repo = repoOrDb instanceof AnalyticsRepository ? repoOrDb : new AnalyticsRepository(repoOrDb);
  }

  async adminDashboard(access: RequestAccess, now = new Date()): Promise<AdminDashboard> {
    if (requireScope(access, PERMISSIONS.REPORTS_VIEW) !== 'ALL')
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'The tenant-wide dashboard needs reports.view at ALL');

    const { day, week, month, previousMonth } = boundaries(now);
    const { tenantId } = access;

    const [
      customers,
      connections,
      services,
      areas,
      recent,
      activity,
      collections,
      daily,
      weekly,
      monthly,
      customerSeries,
      connectionSeries,
    ] = await Promise.all([
      this.repo.customerTotals(tenantId, month, previousMonth),
      this.repo.connectionTotals(tenantId, month, previousMonth),
      this.repo.subscriptionsByService(tenantId),
      this.repo.subscriptionsByArea(tenantId, TOP_AREAS),
      this.repo.recentCustomers(tenantId, RECENT_CUSTOMERS),
      this.repo.recentActivity(tenantId, RECENT_ACTIVITY),
      this.repo.collectionMetrics(this.repo.tenantFilter(tenantId), { day, week, month }).then(toMetrics),
      this.repo.collectionSeries(tenantId, now, 'day', SERIES_STEPS),
      this.repo.collectionSeries(tenantId, now, 'week', SERIES_STEPS),
      this.repo.collectionSeries(tenantId, now, 'month', SERIES_STEPS),
      this.repo.cumulativeSeries(tenantId, now, { table: 'crm.customers', dateColumn: 'created_at' }, SERIES_MONTHS),
      this.repo.cumulativeSeries(tenantId, now, { table: 'crm.subscriptions', dateColumn: 'start_date' }, SERIES_MONTHS),
    ]);

    const serviceTotal = services.reduce((sum, row) => sum + number(row.count), 0);
    const areaTotal = areas.reduce((sum, row) => sum + number(row.count), 0);

    return {
      customers: {
        total: number(customers.total),
        active: number(customers.active),
        inactive: number(customers.inactive),
        pending: number(customers.pending),
        delta: growth(number(customers.current_added), number(customers.previous_added)),
        series: customerSeries,
      },
      connections: {
        total: number(connections.total),
        active: number(connections.active),
        inactive: number(connections.inactive),
        suspended: number(connections.suspended),
        cancelled: number(connections.cancelled),
        delta: growth(number(connections.current_added), number(connections.previous_added)),
        series: connectionSeries,
      },
      collections: {
        ...collections,
        delta: growth(number(collections.month), number(monthly.at(-2)?.value)),
        series: { daily, weekly, monthly },
      },
      outstanding: { amount: money(customers.outstanding), accounts: number(customers.due_accounts) },
      services: services.map(row => ({ ...row, count: number(row.count), share: share(number(row.count), serviceTotal) })),
      areas: areas.map(row => ({ ...row, count: number(row.count), share: share(number(row.count), areaTotal) })),
      recentCustomers: recent.map(row => ({ ...row, name: row.name ?? 'Customer', phone: row.phone ?? '', createdAt: iso(row.createdAt) })),
      activity: activity.map(row => ({ ...row, createdAt: iso(row.createdAt) })),
      generatedAt: now.toISOString(),
    };
  }

  async staffDashboard(access: RequestAccess, now = new Date()): Promise<StaffDashboard> {
    if (requireScope(access, PERMISSIONS.REPORTS_VIEW) === 'ALL')
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'This is the scoped view — a tenant-wide grant gets the admin dashboard');

    const periods = boundaries(now);
    const teamId = await this.repo.teamOfMembership(access.tenantId, access.membershipId);
    const personalFilter = this.repo.collectorFilter(access.tenantId, access.userId);

    const [personal, team, workload, recent] = await Promise.all([
      this.repo.collectionMetrics(personalFilter, periods, 't').then(toMetrics),
      teamId === null
        ? Promise.resolve(null)
        : this.repo.collectionMetrics(this.repo.teamFilter(access.tenantId, teamId), periods, 't').then(toMetrics),
      this.staffWorkload(access),
      this.repo.recentCollections(personalFilter, RECENT_COLLECTIONS),
    ]);

    return {
      personal,
      team,
      workload,
      recentCollections: recent.map(row => ({ ...row, amount: money(row.amount), collectedAt: iso(row.collectedAt) })),
      generatedAt: now.toISOString(),
    };
  }

  private async staffWorkload(access: RequestAccess): Promise<StaffDashboard['workload']> {
    if (access.locationIds.length === 0)
      return { customers: 0, dueCustomers: 0, outstanding: '0.00', activeConnections: 0, inactiveConnections: 0 };

    const row = await this.repo.staffWorkload(access.tenantId, access.locationIds);

    return {
      customers: number(row.customers),
      dueCustomers: number(row.due_customers),
      outstanding: money(row.outstanding),
      activeConnections: number(row.active_connections),
      inactiveConnections: number(row.inactive_connections),
    };
  }
}

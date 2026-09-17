import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { PERMISSIONS } from '@/security/permissions';
import { AdminDashboardResponse, StaffDashboardResponse } from './analytics.schema';
import { AnalyticsService } from './analytics.service';

declare module 'fastify' {
  interface FastifyInstance {
    analytics: AnalyticsService;
  }
}

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('analytics', new AnalyticsService(app.db));

  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef };

  app.get('/analytics/dashboard/admin', {
    config: { cache: { tag: 'analytics' } },
    preHandler: app.requirePermission(PERMISSIONS.REPORTS_VIEW),
    schema: {
      tags: ['analytics'],
      summary: 'High-level business telemetry for tenant administrators',
      description: 'Provides KPI summaries, status breakdowns, revenue trends, and recent transaction activities.',
      response: { 200: AdminDashboardResponse, ...errors },
    },
  }, async (request) => {
    return request.server.analytics.adminDashboard(request.access);
  });

  app.get('/analytics/dashboard/staff', {
    config: { cache: { tag: 'analytics' } },
    preHandler: app.requirePermission(PERMISSIONS.STAFF_VIEW),
    schema: {
      tags: ['analytics'],
      summary: 'Operational and territory telemetry for field agents and managers',
      description: 'Provides territorial stats, connection status, collection metrics, and assigned customers.',
      response: { 200: StaffDashboardResponse, ...errors },
    },
  }, async (request) => {
    return request.server.analytics.staffDashboard(request.access);
  });
};

export default routes;

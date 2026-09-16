import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from './analytics.controller';
import { AdminDashboardResponse, StaffDashboardResponse } from './analytics.schema';
import { AnalyticsService } from './analytics.service';
import './analytics.types';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('analytics', new AnalyticsService(app.db));
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef };

  app.get('/analytics/admin-dashboard', {
    preHandler: app.requirePermission(PERMISSIONS.REPORTS_VIEW),
    schema: { tags: ['analytics'], summary: 'Admin dashboard analytics', response: { 200: AdminDashboardResponse, ...errors } },
  }, controller.adminDashboard);

  app.get('/analytics/staff-dashboard', {
    preHandler: app.requirePermission(PERMISSIONS.REPORTS_VIEW),
    schema: { tags: ['analytics'], summary: 'Personal and team staff analytics', response: { 200: StaffDashboardResponse, ...errors } },
  }, controller.staffDashboard);
};

export default routes;

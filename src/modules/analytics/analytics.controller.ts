import type { Req } from '@/shared/types/request';

export async function adminDashboard(request: Req) {
  return request.server.analytics.adminDashboard(request.access);
}

export async function staffDashboard(request: Req) {
  return request.server.analytics.staffDashboard(request.access);
}

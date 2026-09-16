import type { IdParams, ListCustomersQuery } from './customers.schema';
import type { Req } from '@/shared/types/request';

export async function list(request: Req<{ querystring: typeof ListCustomersQuery }>) {
  return request.server.customers.list(request.access, request.query);
}

export async function detail(request: Req<{ params: typeof IdParams }>) {
  return request.server.customers.detail(request.access, request.params.id);
}

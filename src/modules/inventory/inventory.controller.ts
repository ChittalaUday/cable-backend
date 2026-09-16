import type { FastifyReply } from 'fastify';
import type {
  CreateApprovalRequestBody,
  CreateCatalogItemBody,
  CustomerEquipmentQuery,
  IdParams,
  InwardStockBody,
  IssueEquipmentBody,
  ListStockQuery,
  LocationQuery,
  LookupQuery,
  ReviewApprovalRequestBody,
  TransferStockBody,
  UpdateCatalogItemBody,
} from './inventory.schema';
import type { Req } from '@/shared/types/request';

export async function getDashboard(request: Req<{ querystring: typeof LocationQuery }>) {
  return request.server.inventory.getDashboard(request.access, request.query.locationId);
}

export async function listStock(request: Req<{ querystring: typeof ListStockQuery }>) {
  return request.server.inventory.getStockList(request.access, request.query);
}

export async function getItem(request: Req<{ params: typeof IdParams }>) {
  return request.server.inventory.getItemDetails(request.access, request.params.id);
}

export async function issueEquipment(request: Req<{ body: typeof IssueEquipmentBody }>, reply: FastifyReply) {
  const result = await request.server.inventory.issueEquipment(request.access, request.body);
  return reply.status(201).send(result);
}

export async function createItem(request: Req<{ body: typeof CreateCatalogItemBody }>, reply: FastifyReply) {
  const item = await request.server.inventory.createCatalogItem(request.access, request.body);
  return reply.status(201).send(item);
}

export async function updateItem(request: Req<{ params: typeof IdParams; body: typeof UpdateCatalogItemBody }>) {
  return request.server.inventory.updateCatalogItem(request.access, request.params.id, request.body);
}

export async function deleteItem(request: Req<{ params: typeof IdParams }>) {
  return request.server.inventory.deleteCatalogItem(request.access, request.params.id);
}

export async function createApprovalRequest(request: Req<{ body: typeof CreateApprovalRequestBody }>, reply: FastifyReply) {
  const req = await request.server.inventory.createApprovalRequest(request.access, request.body);
  return reply.status(201).send(req);
}

export async function listApprovalRequests(request: Req) {
  return request.server.inventory.listApprovalRequests(request.access);
}

export async function reviewApprovalRequest(request: Req<{ params: typeof IdParams; body: typeof ReviewApprovalRequestBody }>) {
  return request.server.inventory.reviewApprovalRequest(request.access, request.params.id, request.body);
}

export async function getMovements(request: Req) {
  return request.server.inventory.getMovements(request.access);
}

export async function getLocations(request: Req) {
  return request.server.inventory.getLocations(request.access);
}

export async function lookup(request: Req<{ querystring: typeof LookupQuery }>) {
  return request.server.inventory.lookup(request.access, request.query.q);
}

export async function listCustomerEquipment(request: Req<{ querystring: typeof CustomerEquipmentQuery }>) {
  return request.server.inventory.listCustomerEquipment(request.access, request.query);
}

export async function inwardStock(request: Req<{ body: typeof InwardStockBody }>, reply: FastifyReply) {
  const result = await request.server.inventory.inwardStock(request.access, request.body);
  return reply.status(201).send(result);
}

export async function transferStock(request: Req<{ body: typeof TransferStockBody }>, reply: FastifyReply) {
  const result = await request.server.inventory.transferStock(request.access, request.body);
  return reply.status(201).send(result);
}

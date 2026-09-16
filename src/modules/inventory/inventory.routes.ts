import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/security/permissions';
import {
  ApprovalRequestResponse,
  CatalogItemResponse,
  CreateApprovalRequestBody,
  CreateApprovalRequestResponse,
  CreateCatalogItemBody,
  CustomerEquipmentItem,
  CustomerEquipmentQuery,
  DeleteResponse,
  IdParams,
  InventoryDashboardResponse,
  InventoryLocationResponse,
  InwardStockBody,
  IssueEquipmentBody,
  IssueEquipmentResponse,
  ItemDetailsResponse,
  ListStockQuery,
  LocationQuery,
  LookupItemResponse,
  LookupQuery,
  ReviewApprovalRequestBody,
  StockItemResponse,
  StockMovementResponse,
  TransferStockBody,
  UpdateCatalogItemBody,
} from './inventory.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };
  const errors = { 400: errorRef, 401: errorRef, 403: errorRef, 404: errorRef, 409: errorRef };

  app.get('/inventory/dashboard', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'Inventory overview dashboard stats, low stock items, and recent movements',
      querystring: LocationQuery,
      response: { 200: InventoryDashboardResponse, ...errors },
    },
  }, async (request) => {
    return request.server.inventory.getDashboard(request.access, request.query.locationId);
  });

  app.get('/inventory/locations', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'Get locations for inventory stock filtering',
      response: { 200: Type.Array(InventoryLocationResponse), ...errors },
    },
  }, async (request) => {
    return request.server.inventory.getLocations(request.access);
  });

  app.get('/inventory/stock', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'List catalog items with aggregated stock counts and status breakdown',
      querystring: ListStockQuery,
      response: { 200: Type.Array(StockItemResponse), ...errors },
    },
  }, async (request) => {
    return request.server.inventory.getStockList(request.access, request.query);
  });

  app.get('/inventory/stock/:id', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'Get full catalog item details with serial numbers and recent movements',
      params: IdParams,
      response: { 200: ItemDetailsResponse, ...errors },
    },
  }, async (request) => {
    return request.server.inventory.getItemDetails(request.access, request.params.id);
  });

  app.post('/inventory/catalog', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_MANAGE_CATALOG),
    schema: {
      tags: ['inventory'],
      summary: 'Create a new catalog item definition',
      body: CreateCatalogItemBody,
      response: { 201: CatalogItemResponse, ...errors },
    },
  }, async (request, reply) => {
    const item = await request.server.inventory.createCatalogItem(request.access, request.body);
    return reply.status(201).send(item);
  });

  app.put('/inventory/catalog/:id', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_MANAGE_CATALOG),
    schema: {
      tags: ['inventory'],
      summary: 'Update a catalog item definition',
      params: IdParams,
      body: UpdateCatalogItemBody,
      response: { 200: CatalogItemResponse, ...errors },
    },
  }, async (request) => {
    return request.server.inventory.updateCatalogItem(request.access, request.params.id, request.body);
  });

  app.delete('/inventory/catalog/:id', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_MANAGE_CATALOG),
    schema: {
      tags: ['inventory'],
      summary: 'Soft-delete a catalog item definition',
      params: IdParams,
      response: { 200: DeleteResponse, ...errors },
    },
  }, async (request) => {
    return request.server.inventory.deleteCatalogItem(request.access, request.params.id);
  });

  app.post('/inventory/issue', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_ISSUE),
    schema: {
      tags: ['inventory'],
      summary: 'Issue equipment to a customer with automatic or selected serial',
      body: IssueEquipmentBody,
      response: { 201: IssueEquipmentResponse, ...errors },
    },
  }, async (request, reply) => {
    const result = await request.server.inventory.issueEquipment(request.access, request.body);
    return reply.status(201).send(result);
  });

  app.get('/inventory/customer-equipment', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'List equipment assigned to customers with filtering by customer, catalog item, and location',
      querystring: CustomerEquipmentQuery,
      response: { 200: Type.Array(CustomerEquipmentItem), ...errors },
    },
  }, async (request) => {
    return request.server.inventory.listCustomerEquipment(request.access, request.query);
  });

  app.get('/inventory/lookup', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'Scan / search equipment by serial number, MAC address, or model',
      querystring: LookupQuery,
      response: { 200: LookupItemResponse, ...errors },
    },
  }, async (request) => {
    return request.server.inventory.lookup(request.access, request.query.q);
  });

  app.post('/inventory/inward', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_UPDATE),
    schema: {
      tags: ['inventory'],
      summary: 'Receive new stock into a location with purchase details and serial numbers',
      body: InwardStockBody,
      response: { 201: Type.Object({ success: Type.Boolean(), quantity: Type.Number(), movementId: Type.Union([Type.String(), Type.Null()]) }), ...errors },
    },
  }, async (request, reply) => {
    const result = await request.server.inventory.inwardStock(request.access, request.body);
    return reply.status(201).send(result);
  });

  app.post('/inventory/transfer', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_UPDATE),
    schema: {
      tags: ['inventory'],
      summary: 'Transfer stock between locations or issue to staff',
      body: TransferStockBody,
      response: { 201: Type.Object({ success: Type.Boolean(), equipmentId: Type.String(), movementId: Type.String() }), ...errors },
    },
  }, async (request, reply) => {
    const result = await request.server.inventory.transferStock(request.access, request.body);
    return reply.status(201).send(result);
  });

  app.get('/inventory/movements', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'Get recent stock movement logs',
      response: { 200: Type.Array(StockMovementResponse), ...errors },
    },
  }, async (request) => {
    return request.server.inventory.getMovements(request.access);
  });

  app.post('/inventory/approval-requests', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_UPDATE),
    schema: {
      tags: ['inventory'],
      summary: 'Submit a stock movement request for admin approval',
      body: CreateApprovalRequestBody,
      response: { 201: CreateApprovalRequestResponse, ...errors },
    },
  }, async (request, reply) => {
    const req = await request.server.inventory.createApprovalRequest(request.access, request.body);
    return reply.status(201).send(req);
  });

  app.get('/inventory/approval-requests', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'List approval requests with filtering',
      response: { 200: Type.Array(ApprovalRequestResponse), ...errors },
    },
  }, async (request) => {
    return request.server.inventory.listApprovalRequests(request.access);
  });

  app.patch('/inventory/approval-requests/:id', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_APPROVE),
    schema: {
      tags: ['inventory'],
      summary: 'Approve or reject a stock movement request',
      params: IdParams,
      body: ReviewApprovalRequestBody,
      response: { 200: ApprovalRequestResponse, ...errors },
    },
  }, async (request) => {
    return request.server.inventory.reviewApprovalRequest(request.access, request.params.id, request.body);
  });
};

export default routes;

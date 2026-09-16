import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { LocationsService } from '@/modules/locations/locations.service';
import { PERMISSIONS } from '@/shared/security/permissions';
import * as controller from './inventory.controller';
import {
  ApprovalRequestResponse,
  CreateApprovalRequestBody,
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
import { InventoryService } from './inventory.service';

declare module 'fastify' {
  interface FastifyInstance {
    inventory: InventoryService;
  }
}

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.decorate('inventory', new InventoryService(app.db, new LocationsService(app.db)));

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
  }, controller.getDashboard);

  app.get('/inventory/locations', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'Get locations for inventory stock filtering',
      response: { 200: Type.Array(InventoryLocationResponse), ...errors },
    },
  }, controller.getLocations);

  app.get('/inventory/stock', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'List inventory stock by location with status filters',
      querystring: ListStockQuery,
      response: { 200: Type.Array(StockItemResponse), ...errors },
    },
  }, controller.listStock);

  app.get('/inventory/stock/:id', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'Get item details including serialized units and bundle breakdown',
      params: IdParams,
      response: { 200: ItemDetailsResponse, ...errors },
    },
  }, controller.getItem);

  app.post('/inventory/issue', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_UPDATE),
    schema: {
      tags: ['inventory'],
      summary: 'Issue equipment or accessory to a customer',
      body: IssueEquipmentBody,
      response: { 201: IssueEquipmentResponse, ...errors },
    },
  }, controller.issueEquipment);

  app.post('/inventory/items', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_MANAGE_CATALOG),
    schema: {
      tags: ['inventory'],
      summary: 'Create item in catalog (Admin only)',
      body: CreateCatalogItemBody,
      response: { 201: Type.Any(), ...errors },
    },
  }, controller.createItem);

  app.patch('/inventory/items/:id', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_MANAGE_CATALOG),
    schema: {
      tags: ['inventory'],
      summary: 'Update item in catalog (Admin only)',
      params: IdParams,
      body: UpdateCatalogItemBody,
      response: { 200: Type.Any(), ...errors },
    },
  }, controller.updateItem);

  app.delete('/inventory/items/:id', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_MANAGE_CATALOG),
    schema: {
      tags: ['inventory'],
      summary: 'Delete item from catalog (Admin only)',
      params: IdParams,
      response: { 200: DeleteResponse, ...errors },
    },
  }, controller.deleteItem);

  app.post('/inventory/requests', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'Submit a change approval request (Staff)',
      body: CreateApprovalRequestBody,
      response: { 201: Type.Any(), ...errors },
    },
  }, controller.createApprovalRequest);

  app.get('/inventory/requests', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'List approval requests',
      response: { 200: Type.Array(ApprovalRequestResponse), ...errors },
    },
  }, controller.listApprovalRequests);

  app.post('/inventory/requests/:id/review', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_MANAGE_CATALOG),
    schema: {
      tags: ['inventory'],
      summary: 'Review and approve/reject a change request (Admin only)',
      params: IdParams,
      body: ReviewApprovalRequestBody,
      response: { 200: Type.Any(), ...errors },
    },
  }, controller.reviewApprovalRequest);

  app.get('/inventory/movements', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'Get stock movements log',
      response: { 200: Type.Array(StockMovementResponse), ...errors },
    },
  }, controller.getMovements);

  app.get('/inventory/lookup', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'Lookup equipment or catalog items by barcode, serial, mac, or name',
      querystring: LookupQuery,
      response: { 200: Type.Array(LookupItemResponse), ...errors },
    },
  }, controller.lookup);

  app.get('/inventory/customer-equipment', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_VIEW),
    schema: {
      tags: ['inventory'],
      summary: 'List customer equipment assignments',
      querystring: CustomerEquipmentQuery,
      response: { 200: Type.Array(CustomerEquipmentItem), ...errors },
    },
  }, controller.listCustomerEquipment);

  app.post('/inventory/inward', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_UPDATE),
    schema: {
      tags: ['inventory'],
      summary: 'Inward new stock into inventory with audit logging',
      body: InwardStockBody,
      response: { 201: Type.Any(), ...errors },
    },
  }, controller.inwardStock);

  app.post('/inventory/transfer', {
    preHandler: app.requirePermission(PERMISSIONS.INVENTORY_UPDATE),
    schema: {
      tags: ['inventory'],
      summary: 'Transfer stock between locations or to staff van with audit logging',
      body: TransferStockBody,
      response: { 201: Type.Any(), ...errors },
    },
  }, controller.transferStock);
};

export default routes;

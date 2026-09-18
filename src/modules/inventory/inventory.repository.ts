import type { SQL } from 'drizzle-orm';
import type { Database, Transaction } from '@/db/client';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  approvalRequests,
  customerEquipment,
  customers,
  equipment,
  itemCatalog,
  stockMovements,
  users,
} from '@/db/schema';

export class InventoryRepository {
  constructor(private readonly db: Database) {}

  get database(): Database {
    return this.db;
  }

  async findCatalogItems(tenantId: string) {
    return this.db
      .select()
      .from(itemCatalog)
      .where(and(eq(itemCatalog.tenantId, tenantId), isNull(itemCatalog.deletedAt)))
      .orderBy(desc(itemCatalog.createdAt));
  }

  async findCatalogItemById(tenantId: string, id: string) {
    const [item] = await this.db
      .select()
      .from(itemCatalog)
      .where(and(eq(itemCatalog.tenantId, tenantId), eq(itemCatalog.id, id), isNull(itemCatalog.deletedAt)));
    return item ?? null;
  }

  async createCatalogItem(data: typeof itemCatalog.$inferInsert, tx?: Transaction) {
    const client = tx ?? this.db;
    const [item] = await client.insert(itemCatalog).values(data).returning();
    return item!;
  }

  async updateCatalogItem(tenantId: string, id: string, data: Partial<typeof itemCatalog.$inferInsert>, tx?: Transaction) {
    const client = tx ?? this.db;
    const [updated] = await client
      .update(itemCatalog)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(itemCatalog.tenantId, tenantId), eq(itemCatalog.id, id), isNull(itemCatalog.deletedAt)))
      .returning();
    return updated ?? null;
  }

  async deleteCatalogItem(tenantId: string, id: string) {
    return this.db
      .update(itemCatalog)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(itemCatalog.tenantId, tenantId), eq(itemCatalog.id, id), isNull(itemCatalog.deletedAt)));
  }

  async findEquipmentByTenant(tenantId: string, conditions: SQL[] = []) {
    return this.db
      .select()
      .from(equipment)
      .where(and(eq(equipment.tenantId, tenantId), ...conditions));
  }

  async findEquipmentById(tenantId: string, id: string) {
    const [eqItem] = await this.db
      .select()
      .from(equipment)
      .where(and(eq(equipment.tenantId, tenantId), eq(equipment.id, id)));
    return eqItem ?? null;
  }

  async findEquipmentBySerial(tenantId: string, serialNumber: string) {
    const [eqItem] = await this.db
      .select()
      .from(equipment)
      .where(and(eq(equipment.tenantId, tenantId), eq(equipment.serialNumber, serialNumber)));
    return eqItem ?? null;
  }

  async createEquipment(data: typeof equipment.$inferInsert, tx?: Transaction) {
    const client = tx ?? this.db;
    const [created] = await client.insert(equipment).values(data).returning();
    return created!;
  }

  async updateEquipment(tenantId: string, id: string, data: Partial<typeof equipment.$inferInsert>, tx?: Transaction) {
    const client = tx ?? this.db;
    const [updated] = await client
      .update(equipment)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(equipment.tenantId, tenantId), eq(equipment.id, id)))
      .returning();
    return updated ?? null;
  }

  async findCustomerEquipment(tenantId: string, conditions: SQL[] = []) {
    return this.db
      .select({
        assignment: customerEquipment,
        equipment,
        catalog: itemCatalog,
        customer: customers,
        user: users,
      })
      .from(customerEquipment)
      .innerJoin(equipment, eq(equipment.id, customerEquipment.equipmentId))
      .leftJoin(itemCatalog, eq(itemCatalog.id, equipment.catalogId))
      .innerJoin(customers, eq(customers.id, customerEquipment.customerId))
      .leftJoin(users, eq(users.id, customers.userId))
      .where(and(eq(customerEquipment.tenantId, tenantId), ...conditions))
      .orderBy(desc(customerEquipment.assignedAt));
  }

  async createCustomerEquipment(data: typeof customerEquipment.$inferInsert, tx?: Transaction) {
    const client = tx ?? this.db;
    const [created] = await client.insert(customerEquipment).values(data).returning();
    return created!;
  }

  async findStockMovements(tenantId: string, limit = 50) {
    return this.db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.tenantId, tenantId))
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit);
  }

  async createStockMovement(data: typeof stockMovements.$inferInsert, tx?: Transaction) {
    const client = tx ?? this.db;
    const [created] = await client.insert(stockMovements).values(data).returning();
    return created!;
  }

  async findApprovalRequests(tenantId: string) {
    return this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.tenantId, tenantId))
      .orderBy(desc(approvalRequests.createdAt));
  }

  async findApprovalRequestById(tenantId: string, id: string) {
    const [req] = await this.db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, id)));
    return req ?? null;
  }

  async createApprovalRequest(data: typeof approvalRequests.$inferInsert, tx?: Transaction) {
    const client = tx ?? this.db;
    const [created] = await client.insert(approvalRequests).values(data).returning();
    return created!;
  }

  async updateApprovalRequest(tenantId: string, id: string, data: Partial<typeof approvalRequests.$inferInsert>, tx?: Transaction) {
    const client = tx ?? this.db;
    const [updated] = await client
      .update(approvalRequests)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, id)))
      .returning();
    return updated ?? null;
  }
}

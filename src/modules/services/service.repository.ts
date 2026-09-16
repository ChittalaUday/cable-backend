import type { SQL } from 'drizzle-orm';
import type { Database, Transaction } from '@/db/client';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  locations,
  serviceCoverage,
  serviceProviders,
  services,
} from '@/db/schema';

export class ServiceRepository {
  constructor(private readonly db: Database) {}

  get database(): Database {
    return this.db;
  }

  async listServices(tenantId: string, conditions: SQL[] = []) {
    return this.db
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tenantId), isNull(services.deletedAt), ...conditions))
      .orderBy(asc(services.name));
  }

  async findServiceById(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)));
    return row ?? null;
  }

  async createService(data: typeof services.$inferInsert, tx?: Transaction) {
    const client = tx ?? this.db;
    const [created] = await client.insert(services).values(data).returning();
    return created!;
  }

  async updateService(tenantId: string, id: string, data: Partial<typeof services.$inferInsert>, tx?: Transaction) {
    const client = tx ?? this.db;
    const [updated] = await client
      .update(services)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)))
      .returning();
    return updated ?? null;
  }

  async deleteService(tenantId: string, id: string) {
    return this.db
      .update(services)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)));
  }

  async listProviders(tenantId: string, conditions: SQL[] = []) {
    return this.db
      .select()
      .from(serviceProviders)
      .where(and(eq(serviceProviders.tenantId, tenantId), isNull(serviceProviders.deletedAt), ...conditions))
      .orderBy(asc(serviceProviders.name));
  }

  async findProviderById(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(serviceProviders)
      .where(and(eq(serviceProviders.tenantId, tenantId), eq(serviceProviders.id, id), isNull(serviceProviders.deletedAt)));
    return row ?? null;
  }

  async createProvider(data: typeof serviceProviders.$inferInsert, tx?: Transaction) {
    const client = tx ?? this.db;
    const [created] = await client.insert(serviceProviders).values(data).returning();
    return created!;
  }

  async updateProvider(tenantId: string, id: string, data: Partial<typeof serviceProviders.$inferInsert>, tx?: Transaction) {
    const client = tx ?? this.db;
    const [updated] = await client
      .update(serviceProviders)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(serviceProviders.tenantId, tenantId), eq(serviceProviders.id, id), isNull(serviceProviders.deletedAt)))
      .returning();
    return updated ?? null;
  }

  async deleteProvider(tenantId: string, id: string) {
    return this.db
      .update(serviceProviders)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(serviceProviders.tenantId, tenantId), eq(serviceProviders.id, id), isNull(serviceProviders.deletedAt)));
  }

  async listCoverage(tenantId: string, filter: { providerId?: string; packageId?: string; serviceId?: string }) {
    const conditions = [eq(serviceCoverage.tenantId, tenantId)];
    if (filter.providerId !== undefined)
      conditions.push(eq(serviceCoverage.serviceProviderId, filter.providerId));
    if (filter.packageId !== undefined)
      conditions.push(eq(serviceCoverage.packageId, filter.packageId));
    if (filter.serviceId !== undefined)
      conditions.push(eq(serviceCoverage.serviceId, filter.serviceId));

    return this.db
      .select({
        coverage: serviceCoverage,
        location: locations,
      })
      .from(serviceCoverage)
      .innerJoin(locations, eq(locations.id, serviceCoverage.locationId))
      .where(and(...conditions));
  }
}

import type { SQL } from 'drizzle-orm';
import type { Database, Transaction } from '@/db/client';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import {
  channels,
  packageChannels,
  packages,
  serviceProviders,
  services,
  subscriptions,
} from '@/db/schema';

export class PackageRepository {
  constructor(private readonly db: Database) {}

  get database(): Database {
    return this.db;
  }

  async listPackages(tenantId: string, conditions: SQL[] = []) {
    return this.db
      .select({
        package: packages,
        provider: serviceProviders,
        service: services,
      })
      .from(packages)
      .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(
        eq(packages.tenantId, tenantId),
        isNull(packages.deletedAt),
        ...conditions,
      ))
      .orderBy(asc(packages.name));
  }

  async findPackageById(tenantId: string, id: string) {
    const [row] = await this.db
      .select({
        package: packages,
        provider: serviceProviders,
        service: services,
      })
      .from(packages)
      .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(
        eq(packages.tenantId, tenantId),
        eq(packages.id, id),
        isNull(packages.deletedAt),
      ));

    return row ?? null;
  }

  async createPackage(data: typeof packages.$inferInsert, tx?: Transaction) {
    const client = tx ?? this.db;
    const [pkg] = await client.insert(packages).values(data).returning();
    return pkg!;
  }

  async updatePackage(tenantId: string, id: string, data: Partial<typeof packages.$inferInsert>, tx?: Transaction) {
    const client = tx ?? this.db;
    const [updated] = await client
      .update(packages)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)))
      .returning();
    return updated ?? null;
  }

  async deletePackage(tenantId: string, id: string) {
    return this.db
      .update(packages)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)));
  }

  async findPackageChannels(packageId: string) {
    return this.db
      .select({
        channel: channels,
        isMandatory: packageChannels.isMandatory,
      })
      .from(packageChannels)
      .innerJoin(channels, eq(channels.id, packageChannels.channelId))
      .where(eq(packageChannels.packageId, packageId))
      .orderBy(asc(channels.channelNumber), asc(channels.name));
  }

  async setPackageChannels(packageId: string, channelList: { channelId: string; isMandatory?: boolean }[]) {
    return this.db.transaction(async (tx) => {
      await tx
        .delete(packageChannels)
        .where(eq(packageChannels.packageId, packageId));

      if (channelList.length > 0) {
        await tx.insert(packageChannels).values(
          channelList.map(item => ({
            packageId,
            channelId: item.channelId,
            isMandatory: item.isMandatory ?? false,
          })),
        );
      }
    });
  }

  async listChannels(tenantId: string, conditions: SQL[] = []) {
    return this.db
      .select()
      .from(channels)
      .where(and(
        eq(channels.tenantId, tenantId),
        ...conditions,
      ))
      .orderBy(asc(channels.channelNumber), asc(channels.name));
  }

  async countActiveSubscriptions(tenantId: string, packageId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: count() })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.packageId, packageId),
        isNull(subscriptions.deletedAt),
      ));
    return result?.count ?? 0;
  }
}

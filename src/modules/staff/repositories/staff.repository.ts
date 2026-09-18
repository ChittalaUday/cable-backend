import type { SQL } from 'drizzle-orm';
import type { Database, Transaction } from '@/db/client';
import { and, asc, eq } from 'drizzle-orm';
import {
  membershipLocations,
  roles,
  tenantMemberships,
  users,
} from '@/db/schema';

export class StaffRepository {
  constructor(private readonly db: Database) {}

  get database(): Database {
    return this.db;
  }

  async listStaff(tenantId: string, conditions: SQL[] = []) {
    return this.db
      .select({
        membership: tenantMemberships,
        user: users,
        role: roles,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .innerJoin(roles, eq(roles.id, tenantMemberships.roleId))
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.roleId, 'staff'),
        ...conditions,
      ))
      .orderBy(asc(users.name));
  }

  async findStaffById(tenantId: string, id: string) {
    const [row] = await this.db
      .select({
        membership: tenantMemberships,
        user: users,
        role: roles,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .innerJoin(roles, eq(roles.id, tenantMemberships.roleId))
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.id, id),
      ));
    return row ?? null;
  }

  async findStaffLocations(membershipId: string) {
    return this.db
      .select({
        locationId: membershipLocations.locationId,
      })
      .from(membershipLocations)
      .where(eq(membershipLocations.membershipId, membershipId));
  }

  async setStaffLocations(membershipId: string, locationIds: string[], tx?: Transaction) {
    const client = tx ?? this.db;
    await client
      .delete(membershipLocations)
      .where(eq(membershipLocations.membershipId, membershipId));

    if (locationIds.length > 0) {
      await client.insert(membershipLocations).values(
        locationIds.map(locationId => ({
          membershipId,
          locationId,
        })),
      );
    }
  }
}

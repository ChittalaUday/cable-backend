import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/db/schema';
import { and, eq, or } from 'drizzle-orm';
import { SYSTEM_ROLES } from '@/config/constants';
import {
  locations,
  membershipLocations,
  teamLocations,
  teams,
  tenantMemberships,
  users,
} from '@/db/schema';
import { hashPassword } from '@/security/password';
import { assertSystemRolesPresent } from './seed-roles';

type Db = NodePgDatabase<typeof schema>;

export const SEEDED_STAFF_PASSWORD = 'Staff@123456';

export async function seedStaff(db: Db, tenantId: string): Promise<void> {
  // Every membership below references a role. Without them this fails as a raw
  // foreign key violation halfway through; say what is actually wrong instead.
  await assertSystemRolesPresent(db);

  const passwordHash = await hashPassword(SEEDED_STAFF_PASSWORD);

  // 1. Resolve Mandapeta and Kapileswaram locations
  const [mandapeta] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.tenantId, tenantId), or(eq(locations.code, 'MDP'), eq(locations.name, 'Mandapeta'))))
    .limit(1);

  const [kapileswaram] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.tenantId, tenantId), eq(locations.name, 'Kapileswaram')))
    .limit(1);

  if (!mandapeta || !kapileswaram) {
    console.warn('⚠️ Cannot seed staff: Mandapeta or Kapileswaram location not found for tenant', tenantId);
    return;
  }

  // Helper to upsert user and membership
  async function upsertStaffMember(input: {
    name: string;
    email: string;
    phone: string;
    teamId?: string | null;
  }) {
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(or(eq(users.email, input.email), eq(users.phone, input.phone)));

    let userId: string;
    if (existingUser) {
      await db
        .update(users)
        .set({
          name: input.name,
          email: input.email,
          phone: input.phone,
          passwordHash,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existingUser.id));
      userId = existingUser.id;
    }
    else {
      const [inserted] = await db
        .insert(users)
        .values({
          name: input.name,
          email: input.email,
          phone: input.phone,
          passwordHash,
        })
        .returning({ id: users.id });
      userId = inserted!.id;
    }

    const [existingMembership] = await db
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.tenantId, tenantId)));

    let membershipId: string;
    if (existingMembership) {
      await db
        .update(tenantMemberships)
        .set({
          roleId: SYSTEM_ROLES.STAFF,
          status: 'active',
          teamId: input.teamId ?? null,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(tenantMemberships.id, existingMembership.id));
      membershipId = existingMembership.id;
    }
    else {
      const [inserted] = await db
        .insert(tenantMemberships)
        .values({
          userId,
          tenantId,
          roleId: SYSTEM_ROLES.STAFF,
          status: 'active',
          teamId: input.teamId ?? null,
        })
        .returning({ id: tenantMemberships.id });
      membershipId = inserted!.id;
    }

    return { userId, membershipId };
  }

  // 2. Create Teams for Mandapeta
  async function upsertTeam(name: string, slug: string) {
    const [existing] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.tenantId, tenantId), eq(teams.slug, slug)));

    if (existing) {
      await db
        .update(teams)
        .set({ name, status: 'active', deletedAt: null, updatedAt: new Date() })
        .where(eq(teams.id, existing.id));
      return existing.id;
    }

    const [created] = await db
      .insert(teams)
      .values({
        tenantId,
        name,
        slug,
        status: 'active',
      })
      .returning({ id: teams.id });
    return created!.id;
  }

  const team1Id = await upsertTeam('Mandapeta Field Crew 1', 'mandapeta-field-crew-1');
  const team2Id = await upsertTeam('Mandapeta Field Crew 2', 'mandapeta-field-crew-2');

  // Assign Mandapeta location to both teams
  await db.insert(teamLocations).values([
    { teamId: team1Id, locationId: mandapeta.id },
    { teamId: team2Id, locationId: mandapeta.id },
  ]).onConflictDoNothing();

  // 3. Staff 1: Mandapeta Team 1 Leader
  const staff1 = await upsertStaffMember({
    name: 'Ramesh Varma (Lead)',
    email: 'ramesh.lead@sscn.com',
    phone: '9848012341',
    teamId: team1Id,
  });
  await db
    .update(teams)
    .set({ leaderMembershipId: staff1.membershipId })
    .where(eq(teams.id, team1Id));
  await db.insert(membershipLocations).values({
    membershipId: staff1.membershipId,
    locationId: mandapeta.id,
  }).onConflictDoNothing();

  // 4. Staff 2: Mandapeta Team 1 Staff Member
  const staff2 = await upsertStaffMember({
    name: 'Suresh Babu',
    email: 'suresh.staff@sscn.com',
    phone: '9848012342',
    teamId: team1Id,
  });
  await db.insert(membershipLocations).values({
    membershipId: staff2.membershipId,
    locationId: mandapeta.id,
  }).onConflictDoNothing();

  // 5. Staff 3: Mandapeta Team 2 Leader
  const staff3 = await upsertStaffMember({
    name: 'Kiran Kumar (Lead)',
    email: 'kiran.lead@sscn.com',
    phone: '9848012343',
    teamId: team2Id,
  });
  await db
    .update(teams)
    .set({ leaderMembershipId: staff3.membershipId })
    .where(eq(teams.id, team2Id));
  await db.insert(membershipLocations).values({
    membershipId: staff3.membershipId,
    locationId: mandapeta.id,
  }).onConflictDoNothing();

  // 6. Staff 4: Kapileswarapuram Location Staff
  const staff4 = await upsertStaffMember({
    name: 'Venkat Rao',
    email: 'venkat.kap@sscn.com',
    phone: '9848012344',
  });
  await db.insert(membershipLocations).values({
    membershipId: staff4.membershipId,
    locationId: kapileswaram.id,
  }).onConflictDoNothing();

  // 7. Staff 5: All Locations Staff (assigned to both Mandapeta and Kapileswaram)
  const staff5 = await upsertStaffMember({
    name: 'Anand Sharma',
    email: 'anand.all@sscn.com',
    phone: '9848012345',
  });
  await db.insert(membershipLocations).values([
    { membershipId: staff5.membershipId, locationId: mandapeta.id },
    { membershipId: staff5.membershipId, locationId: kapileswaram.id },
  ]).onConflictDoNothing();

  console.log('✅ Seeded 5 staff members (2 teams in Mandapeta with leaders, 1 staff in Kapileswarapuram, 1 staff across all locations)');
}

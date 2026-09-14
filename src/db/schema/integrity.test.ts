import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { channels, customers, files, otpCodes, packages, roles, serviceProviders, services, teams, tenantMemberships, tenants, users } from '@/db/schema';
import { createTestDb, inRollback } from '@/test/db';

const { db, close } = createTestDb();
afterAll(async () => close());

describe('database integrity', () => {
  it('accepts only the three tenant membership roles', async () => {
    await expect(db.insert(roles)
      .values({ id: `custom-${randomUUID()}`, name: 'Custom' }))
      .rejects
      .toThrow();
  });

  it('allows an imported customer without a login account', async () => {
    await inRollback(db, async (tx) => {
      const [tenant] = await tx.insert(tenants)
        .values({ code: `I${randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase()}`, name: 'Import Test' })
        .returning();

      const [customer] = await tx.insert(customers)
        .values({ tenantId: tenant!.id, customerCode: `${tenant!.code}-000001`, userId: null })
        .returning();

      expect(customer?.userId).toBeNull();
    });
  });

  /**
   * A team is one operator's crew and can never be shared. The guard is a
   * composite foreign key on `(tenant_id, team_id)`, not a `WHERE tenant_id = ?`
   * in the service — this is the test that says so.
   */
  describe('teams belong to exactly one tenant', () => {
    const code = () => `T${randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase()}`;

    it('refuses a membership pointed at another tenant\'s team', async () => {
      await inRollback(db, async (tx) => {
        const [a] = await tx.insert(tenants).values({ code: code(), name: 'Operator A' }).returning();
        const [b] = await tx.insert(tenants).values({ code: code(), name: 'Operator B' }).returning();
        const [bTeam] = await tx.insert(teams).values({ tenantId: b!.id, name: 'B Crew', slug: 'b-crew' }).returning();
        const [user] = await tx.insert(users).values({ phone: `9${randomUUID().replaceAll(/\D/g, '').slice(0, 9)}` }).returning();

        await expect(tx.insert(tenantMemberships).values({
          userId: user!.id,
          tenantId: a!.id,
          roleId: 'staff',
          teamId: bTeam!.id,
        })).rejects.toThrow();
      });
    });

    it('accepts a team of the membership\'s own tenant, and no team at all', async () => {
      await inRollback(db, async (tx) => {
        const [tenant] = await tx.insert(tenants).values({ code: code(), name: 'Operator C' }).returning();
        const [team] = await tx.insert(teams).values({ tenantId: tenant!.id, name: 'Crew', slug: 'crew' }).returning();

        const [onTeam] = await tx.insert(users).values({ phone: `9${randomUUID().replaceAll(/\D/g, '').slice(0, 9)}` }).returning();
        const [onNone] = await tx.insert(users).values({ phone: `9${randomUUID().replaceAll(/\D/g, '').slice(0, 9)}` }).returning();

        const [joined] = await tx.insert(tenantMemberships)
          .values({ userId: onTeam!.id, tenantId: tenant!.id, roleId: 'staff', teamId: team!.id })
          .returning();
        expect(joined?.teamId).toBe(team!.id);

        // `team_id` is nullable and the FK is MATCH SIMPLE, so "on no team" stays legal.
        const [unassigned] = await tx.insert(tenantMemberships)
          .values({ userId: onNone!.id, tenantId: tenant!.id, roleId: 'staff', teamId: null })
          .returning();
        expect(unassigned?.teamId).toBeNull();
      });
    });

    it('lets two tenants each have a team of the same name', async () => {
      await inRollback(db, async (tx) => {
        const [a] = await tx.insert(tenants).values({ code: code(), name: 'Operator D' }).returning();
        const [b] = await tx.insert(tenants).values({ code: code(), name: 'Operator E' }).returning();

        await tx.insert(teams).values({ tenantId: a!.id, name: 'Collections', slug: 'collections' });
        await tx.insert(teams).values({ tenantId: b!.id, name: 'Collections', slug: 'collections' });

        // ...but not one tenant twice.
        await expect(tx.insert(teams).values({ tenantId: a!.id, name: 'Dupe', slug: 'collections' }))
          .rejects
          .toThrow();
      });
    });

    it('keeps a team that still has members', async () => {
      await inRollback(db, async (tx) => {
        const [tenant] = await tx.insert(tenants).values({ code: code(), name: 'Operator F' }).returning();
        const [team] = await tx.insert(teams).values({ tenantId: tenant!.id, name: 'Crew', slug: 'crew' }).returning();
        const [user] = await tx.insert(users).values({ phone: `9${randomUUID().replaceAll(/\D/g, '').slice(0, 9)}` }).returning();
        await tx.insert(tenantMemberships).values({ userId: user!.id, tenantId: tenant!.id, roleId: 'staff', teamId: team!.id });

        // Hard delete is refused — empty the team first. Soft delete is the normal path.
        await expect(tx.delete(teams).where(eq(teams.id, team!.id))).rejects.toThrow();
      });
    });
  });

  it('allows only one active OTP per identifier and purpose', async () => {
    await inRollback(db, async (tx) => {
      const identifier = `91${randomUUID().replaceAll('-', '').slice(0, 10)}`;
      const value = { identifier, channel: 'whatsapp', codeHash: 'hash', maxAttempts: 5, expiresAt: new Date(Date.now() + 60_000) };
      await tx.insert(otpCodes).values(value);
      await expect(tx.insert(otpCodes).values(value)).rejects.toThrow();
    });
  });

  it('lets two providers of one service use the same channel number', async () => {
    await inRollback(db, async (tx) => {
      const [tenant] = await tx.insert(tenants)
        .values({ code: `C${randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase()}`, name: 'Channel Test' })
        .returning();

      const [service] = await tx.insert(services)
        .values({ tenantId: tenant!.id, name: 'Cable TV', slug: 'cable-tv', icon: 'tv' })
        .returning();

      const provider = async (slug: string) => (await tx.insert(serviceProviders)
        .values({ tenantId: tenant!.id, serviceId: service!.id, name: slug, slug })
        .returning())[0]!;

      const act = await provider('act-digital');
      const hathway = await provider('hathway');

      const channel = (serviceProviderId: string) => ({
        tenantId: tenant!.id,
        serviceProviderId,
        channelNumber: 101,
        name: 'Channel 101',
        slug: 'channel-101',
      });

      await tx.insert(channels).values(channel(act.id));

      // Two MSOs both numbering something 101 is normal; on `service_id` it was
      // a false conflict (docs/services-providers-packages.md §3).
      await expect(tx.insert(channels).values(channel(hathway.id))).resolves.toBeDefined();
      await expect(tx.insert(channels).values(channel(act.id))).rejects.toThrow();
    });
  });

  it('refuses two packages with one slug under the same provider', async () => {
    await inRollback(db, async (tx) => {
      const [tenant] = await tx.insert(tenants)
        .values({ code: `P${randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase()}`, name: 'Package Test' })
        .returning();

      const [service] = await tx.insert(services)
        .values({ tenantId: tenant!.id, name: 'Broadband', slug: 'broadband', icon: 'wifi' })
        .returning();

      const [provider] = await tx.insert(serviceProviders)
        .values({ tenantId: tenant!.id, serviceId: service!.id, name: 'ACT', slug: 'act' })
        .returning();

      const value = { tenantId: tenant!.id, serviceProviderId: provider!.id, name: '100 Mbps', slug: '100-mbps' };
      await tx.insert(packages).values(value);

      await expect(tx.insert(packages).values(value)).rejects.toThrow();
    });
  });

  it('deduplicates active physical files by checksum', async () => {
    await inRollback(db, async (tx) => {
      const checksum = randomUUID();
      const value = (storageKey: string) => ({ storageKey, bucket: 'test', contentType: 'text/plain', checksum });
      await tx.insert(files).values(value(randomUUID()));
      await expect(tx.insert(files).values(value(randomUUID()))).rejects.toThrow();
    });
  });
});

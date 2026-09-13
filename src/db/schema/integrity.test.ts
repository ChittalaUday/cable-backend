import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { channels, customers, files, otpCodes, packages, roles, serviceProviders, services, tenants } from '@/db/schema';
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
        .values({ tenantId: tenant!.id, name: 'Cable TV', slug: 'cable-tv', serviceType: 'cable' })
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
        .values({ tenantId: tenant!.id, name: 'Broadband', slug: 'broadband', serviceType: 'broadband' })
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

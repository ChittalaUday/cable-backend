import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { customers, files, otpCodes, roles, tenants } from '@/db/schema';
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

  it('deduplicates active physical files by checksum', async () => {
    await inRollback(db, async (tx) => {
      const checksum = randomUUID();
      const value = (storageKey: string) => ({ storageKey, bucket: 'test', contentType: 'text/plain', checksum });
      await tx.insert(files).values(value(randomUUID()));
      await expect(tx.insert(files).values(value(randomUUID()))).rejects.toThrow();
    });
  });
});

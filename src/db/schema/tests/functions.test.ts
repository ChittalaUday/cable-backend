import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { PERMISSION_SCOPES, SCOPE_RANK } from '@/security/permissions';
import { createTestDb } from '@/test/db';
import { normaliseEmail, normalizeEmail } from '../functions';

const { db, close } = createTestDb();
afterAll(async () => close());

describe('crm.normalize_phone', () => {
  it.each([
    ['+91-83091 54716', '918309154716'],
    ['(555) 010-9999', '5550109999'],
    ['918309154716', '918309154716'],
    ['', ''],
  ])('reduces %j to digits %j', async (input, expected) => {
    const result = await db.execute<{ out: string }>(sql`SELECT crm.normalize_phone(${input}) AS out`);
    expect(result.rows[0]?.out).toBe(expected);
  });

  it('returns null for null, so an index entry is never a bogus empty string', async () => {
    const result = await db.execute<{ out: string | null }>(sql`SELECT crm.normalize_phone(NULL) AS out`);
    expect(result.rows[0]?.out).toBeNull();
  });

  it('is IMMUTABLE, which is what lets an expression index use it', async () => {
    const result = await db.execute<{ provolatile: string }>(sql`
      SELECT p.provolatile FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'crm' AND p.proname = 'normalize_phone'
    `);
    expect(result.rows[0]?.provolatile).toBe('i');
  });
});

describe('iam.scope_rank', () => {
  it('agrees with SCOPE_RANK in TypeScript for every scope', async () => {
    for (const scope of PERMISSION_SCOPES) {
      const result = await db.execute<{ rank: number }>(sql`SELECT iam.scope_rank(${scope}) AS rank`);
      expect(result.rows[0]?.rank, `scope_rank(${scope})`).toBe(SCOPE_RANK[scope]);
    }
  });

  it('ranks an unknown scope below every real one, so it can never grant access', async () => {
    const result = await db.execute<{ rank: number }>(sql`SELECT iam.scope_rank('WHATEVER') AS rank`);
    expect(result.rows[0]?.rank).toBe(0);
    expect(Math.min(...Object.values(SCOPE_RANK))).toBeGreaterThan(0);
  });
});

describe('read models', () => {
  it.each(['analytics.tenant_customer_stats', 'notify.user_unread_counts', 'analytics.messaging_health'])(
    '%s is queryable',
    async (view) => {
      const result = await db.execute(sql`SELECT * FROM ${sql.raw(view)} LIMIT 1`);
      expect(Array.isArray(result.rows)).toBe(true);
    },
  );
});

describe('auth.normalise_email', () => {
  it.each([
    ['  Ravi.Kumar@Example.COM ', 'ravi.kumar@example.com'],
    ['ravi@example.com', 'ravi@example.com'],
    ['   ', null],
    ['', null],
  ])('normalises %j to %j', async (input, expected) => {
    const result = await db.execute<{ out: string | null }>(sql`SELECT ${normaliseEmail(input)} AS out`);
    expect(result.rows[0]?.out).toBe(expected);
  });

  it('returns null for null', async () => {
    const result = await db.execute<{ out: string | null }>(sql`SELECT ${normalizeEmail(null)} AS out`);
    expect(result.rows[0]?.out).toBeNull();
  });

  it('is IMMUTABLE and PARALLEL SAFE', async () => {
    const result = await db.execute<{ provolatile: string; proparallel: string }>(sql`
      SELECT p.provolatile, p.proparallel FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'auth' AND p.proname = 'normalise_email'
    `);
    expect(result.rows[0]?.provolatile).toBe('i');
    expect(result.rows[0]?.proparallel).toBe('s');
  });
});

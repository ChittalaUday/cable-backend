import type { BuiltApp } from '@/app';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';

let app: BuiltApp;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/**
 * The staff and teams services call `access.invalidate()` when a grant moves,
 * and the request guard authorises against `app.access`. If those are two
 * objects the write clears a cache nobody reads, and a re-assigned engineer
 * keeps their old areas — and their old cached pages — until the TTL expires.
 * Cheap to break by accident, so it is pinned here.
 */
describe('the services that move grants share the cache the guard reads', () => {
  it.each(['staff', 'teams'] as const)('%s resolves against app.access', (name) => {
    const service = app[name] as unknown as { access: unknown };

    expect(service.access).toBe(app.access);
  });

  it('builds exactly one AccessService', () => {
    expect(app.access).toBeDefined();
    expect((app.staff as unknown as { access: unknown }).access)
      .toBe((app.teams as unknown as { access: unknown }).access);
  });
});

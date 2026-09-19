import type { BuiltApp } from '@/app';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { NO_CACHE_EFFECT, ROUTE_WRITES, TAG_READS, tagsAffectedBy } from '../cache-dependencies';

let app: BuiltApp;

interface RouteRow {
  name: string;
  method: string;
  url: string;
  cacheTag: string | undefined;
  invalidates: readonly string[];
  mutating: boolean;
}

let rows: RouteRow[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const seen = new Map<string, RouteRow>();

  for (const route of app.routeTable) {
    const methods = Array.isArray(route.method) ? route.method : [route.method];

    for (const method of methods) {
      if (!route.url.startsWith('/api/v1/') || method === 'HEAD' || method === 'OPTIONS')
        continue;

      seen.set(`${method} ${route.url}`, {
        name: `${method} ${route.url}`,
        method,
        url: route.url,
        cacheTag: route.cacheTag,
        invalidates: route.invalidates,
        mutating: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method),
      });
    }
  }

  rows = [...seen.values()];
});

afterAll(async () => {
  await app.close();
});

describe('the cache dependency model', () => {
  it('describes every tag the app actually caches under', () => {
    const live = [...new Set(rows.map(row => row.cacheTag).filter((tag): tag is string => tag !== undefined))].sort();

    expect(live).toEqual(Object.keys(TAG_READS).sort());
  });

  it('accounts for every mutating route, either as a writer or as harmless', () => {
    const unaccounted = rows
      .filter(row => row.mutating)
      .map(row => row.name)
      .filter(name => !(name in ROUTE_WRITES) && !(name in NO_CACHE_EFFECT));

    expect(unaccounted).toEqual([]);
  });

  it('names no tag that does not exist', () => {
    const known = new Set(Object.keys(TAG_READS));
    const bogus = rows
      .flatMap(row => row.invalidates.map(tag => ({ route: row.name, tag })))
      .filter(entry => !known.has(entry.tag))
      .map(entry => `${entry.route} -> ${entry.tag}`);

    expect(bogus).toEqual([]);
  });
});

describe('every write drops every cache its change can be seen through', () => {
  it('leaves no stale tag behind', () => {
    const missing: string[] = [];

    for (const row of rows) {
      const written = ROUTE_WRITES[row.name];
      if (written === undefined)
        continue;

      const required = tagsAffectedBy(row.name, written);
      const declared = new Set(row.invalidates);
      const gaps = required.filter(tag => !declared.has(tag));

      if (gaps.length > 0)
        missing.push(`${row.name} writes [${written.join(', ')}] but does not drop [${gaps.join(', ')}]`);
    }

    expect(missing).toEqual([]);
  });
});

import type { BuiltApp } from '@/app';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { AUDITED_ROUTES, MUTATING_METHODS, UNAUDITED_ROUTES } from './audited-routes';

let app: BuiltApp;
let mutating: string[];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  mutating = app.routeTable
    .flatMap(route => (Array.isArray(route.method) ? route.method : [route.method])
      .map(method => `${method} ${route.url}`))
    .filter(key => MUTATING_METHODS.some(method => key.startsWith(`${method} `)));
});

afterAll(async () => app.close());

describe('audit coverage', () => {
  it('finds the mutating routes at all', () => {
    expect(mutating.length).toBeGreaterThan(20);
  });

  it('records every route that changes something', () => {
    const declared = new Set([...Object.keys(AUDITED_ROUTES), ...Object.keys(UNAUDITED_ROUTES)]);
    const undeclared = mutating.filter(key => !declared.has(key));

    expect(undeclared, [
      'These routes change something and say nothing about auditing.',
      'Add each to AUDITED_ROUTES with the action it writes, or to',
      'UNAUDITED_ROUTES with the reason it writes nothing.',
    ].join(' ')).toEqual([]);
  });

  it('has no entry for a route that no longer exists', () => {
    const live = new Set(mutating);
    const stale = [...Object.keys(AUDITED_ROUTES), ...Object.keys(UNAUDITED_ROUTES)]
      .filter(key => !live.has(key));

    expect(stale, 'Remove these from audited-routes.ts — the routes are gone.').toEqual([]);
  });

  it('names actions in the documented <entity>.<verb> shape', () => {
    const malformed = Object.values(AUDITED_ROUTES)
      .flat()
      .filter(action => !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(action));

    expect(malformed).toEqual([]);
  });
});

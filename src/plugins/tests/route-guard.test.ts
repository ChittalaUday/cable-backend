import type { BuiltApp } from '@/app';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { ALL_PERMISSION_KEYS } from '@/security/permissions';

let app: BuiltApp;

const UNGUARDED_ROUTES: Readonly<Record<string, string>> = {
  'GET /health': 'Liveness for the load balancer. Public by design.',
  'GET /api/v1/health': 'The same probe under the version prefix.',
  'GET /metrics': 'Prometheus scrape. Public inside the deployment network.',

  'POST /api/v1/auth/otp/request': 'Signing in. There is no session to hold a permission yet.',
  'POST /api/v1/auth/otp/verify': 'Signing in.',
  'POST /api/v1/auth/login': 'Signing in.',
  'POST /api/v1/auth/refresh': 'Rotating a refresh token — authority is the token itself.',

  'POST /api/v1/auth/logout': 'Ends the caller\'s own session. Needing a permission to sign out is how someone gets stuck signed in.',
  'POST /api/v1/auth/logout-all': 'Ends the caller\'s own sessions, nobody else\'s.',
  'GET /api/v1/auth/me': 'The caller\'s own identity and memberships. Scoped to the session, so a grant would add nothing.',

  'GET /api/v1/notifications': 'The caller\'s own inbox, scoped to their user id. A grant would only let somebody read their own post.',
  'GET /api/v1/notifications/unread-count': 'The caller\'s own badge count.',
  'PATCH /api/v1/notifications/:id/read': 'Marks one of the caller\'s own notifications read; the update is scoped to their user id.',
  'PATCH /api/v1/notifications/read-all': 'Marks the caller\'s own notifications read.',
  'POST /api/v1/notifications/token': 'Records a device and its push token before anybody has signed in, and keeps recording it after sign-out. There is no session to hold a permission.',

  'POST /api/v1/files': 'Anybody signed in may upload — a customer attaching proof of payment as much as an admin picking a banner. The limits that matter are size, content type and rate, not a grant.',
  'GET /api/v1/files/:id': 'Resolved through findOwned, so it only ever signs a URL for a file in the caller\'s own tenant.',
  'DELETE /api/v1/files/:id': 'The same ownership check. Deleting your own upload needs no grant.',
};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => app.close());

const DOCS_PREFIX = '/docs';

function routeKeys(): { key: string; permission: string | undefined }[] {
  return app.routeTable
    .filter(route => !route.url.startsWith(DOCS_PREFIX))
    .flatMap(route =>
      (Array.isArray(route.method) ? route.method : [route.method])
        .filter(method => method !== 'HEAD' && method !== 'OPTIONS')
        .map(method => ({ key: `${method} ${route.url}`, permission: route.permission })),
    );
}

describe('route guard coverage', () => {
  it('finds the routes at all', () => {
    expect(routeKeys().length).toBeGreaterThan(30);
  });

  it('gives every route either a permission or a written reason', () => {
    const unguarded = routeKeys()
      .filter(route => route.permission === undefined)
      .map(route => route.key)
      .filter(key => !(key in UNGUARDED_ROUTES));

    expect(unguarded, [
      'These routes carry no permission guard.',
      'Add `preHandler: app.requirePermission(PERMISSIONS.X)`, or add the route',
      'to UNGUARDED_ROUTES in this file with the reason it needs none.',
    ].join(' ')).toEqual([]);
  });

  it('has no exemption for a route that no longer exists', () => {
    const live = new Set(routeKeys().map(route => route.key));
    const stale = Object.keys(UNGUARDED_ROUTES).filter(key => !live.has(key));

    expect(stale, 'Remove these from UNGUARDED_ROUTES — the routes are gone.').toEqual([]);
  });

  it('never exempts a route that does hold a permission', () => {
    const contradictory = routeKeys()
      .filter(route => route.permission !== undefined && route.key in UNGUARDED_ROUTES)
      .map(route => route.key);

    expect(contradictory).toEqual([]);
  });

  it('guards only on permissions that exist', () => {
    const known = new Set<string>(ALL_PERMISSION_KEYS);
    const unknown = routeKeys()
      .filter(route => route.permission !== undefined && !known.has(route.permission))
      .map(route => `${route.key} → ${route.permission}`);

    expect(unknown, 'A guard names a permission that is not in shared/security/permissions.ts.').toEqual([]);
  });
});

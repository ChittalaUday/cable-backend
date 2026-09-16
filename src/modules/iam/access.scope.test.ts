import type { AccessContext } from './access.service';
import type { PermissionKey, PermissionScope } from '@/security/permissions';
import { describe, expect, it } from 'vitest';
import { DomainError, ERROR_CODES } from '@/errors';
import { PERMISSION_SCOPES, PERMISSIONS } from '@/security/permissions';
import { locationScopeFor, requireScope, scopeFor } from './access.service';

const NODES = ['node-a', 'node-b'] as const;

function contextWith(grants: Partial<Record<PermissionKey, PermissionScope>>): AccessContext {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    membershipId: 'membership-1',
    roleId: 'staff',
    teamId: 'team-1',
    isTeamLeader: false,
    permissions: new Map(Object.entries(grants) as [PermissionKey, PermissionScope][]),
    locationIds: [...NODES],
  };
}

describe('requireScope', () => {
  it('returns the scope the caller holds', () => {
    const context = contextWith({ [PERMISSIONS.CUSTOMERS_VIEW]: 'LOCATION' });

    expect(requireScope(context, PERMISSIONS.CUSTOMERS_VIEW)).toBe('LOCATION');
  });

  it('refuses a key the caller does not hold, rather than defaulting', () => {
    const context = contextWith({ [PERMISSIONS.CUSTOMERS_VIEW]: 'ALL' });

    expect(() => requireScope(context, PERMISSIONS.INVENTORY_VIEW)).toThrow(DomainError);

    try {
      requireScope(context, PERMISSIONS.INVENTORY_VIEW);
      expect.unreachable('a missing permission must throw');
    }
    catch (error) {
      expect((error as DomainError).statusCode).toBe(403);
      expect((error as DomainError).code).toBe(ERROR_CODES.PERM_DENIED);
    }
  });

  it('never reports a scope for a key held at no scope', () => {
    const context = contextWith({});

    expect(scopeFor(context, PERMISSIONS.CUSTOMERS_VIEW)).toBeNull();
    expect(() => requireScope(context, PERMISSIONS.CUSTOMERS_VIEW)).toThrow(DomainError);
  });
});

describe('locationScopeFor', () => {
  it('gives the whole tenant only for ALL', () => {
    const context = contextWith({ [PERMISSIONS.CUSTOMERS_VIEW]: 'ALL' });

    expect(locationScopeFor(context, PERMISSIONS.CUSTOMERS_VIEW)).toEqual({ kind: 'ALL_TENANT_LOCATIONS' });
  });

  it('gives the granted nodes for LOCATION', () => {
    const context = contextWith({ [PERMISSIONS.CUSTOMERS_VIEW]: 'LOCATION' });

    expect(locationScopeFor(context, PERMISSIONS.CUSTOMERS_VIEW)).toEqual({
      kind: 'NODES',
      nodeIds: [...NODES],
    });
  });

  it.each(['TEAM', 'ASSIGNED', 'OWN'] as const)('reaches no nodes at %s, even holding area grants', (scope) => {
    const context = contextWith({ [PERMISSIONS.CUSTOMERS_VIEW]: scope });

    expect(context.locationIds.length).toBeGreaterThan(0);
    expect(locationScopeFor(context, PERMISSIONS.CUSTOMERS_VIEW)).toEqual({ kind: 'NODES', nodeIds: [] });
  });

  it('is empty at LOCATION when nothing was granted — not tenant-wide', () => {
    const context = { ...contextWith({ [PERMISSIONS.CUSTOMERS_VIEW]: 'LOCATION' }), locationIds: [] };

    expect(locationScopeFor(context, PERMISSIONS.CUSTOMERS_VIEW)).toEqual({ kind: 'NODES', nodeIds: [] });
  });

  it('refuses outright rather than resolving a key the caller does not hold', () => {
    expect(() => locationScopeFor(contextWith({}), PERMISSIONS.CUSTOMERS_VIEW)).toThrow(DomainError);
  });

  it('never answers ALL_TENANT_LOCATIONS for any scope but ALL', () => {
    const widened = PERMISSION_SCOPES
      .filter(scope => scope !== 'ALL')
      .filter(scope => locationScopeFor(contextWith({ [PERMISSIONS.CUSTOMERS_VIEW]: scope }), PERMISSIONS.CUSTOMERS_VIEW).kind !== 'NODES');

    expect(widened).toEqual([]);
  });
});

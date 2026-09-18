import type { AnalyticsService } from './analytics.service';
import type { Database } from '@/db/client';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionScope } from '@/security/permissions';
import { describe, expect, it } from 'vitest';
import { DomainError, ERROR_CODES } from '@/errors';
import { PERMISSIONS } from '@/security/permissions';
import { AnalyticsService as Analytics } from './analytics.service';

function noQuery(): never {
  throw new Error('the refusal must happen before any query runs');
}

const refuses = new Proxy({}, { get: () => noQuery }) as Database;
const service: AnalyticsService = new Analytics(refuses);

function caller(roleId: string, scope: PermissionScope | null): RequestAccess {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    membershipId: 'membership-1',
    roleId,
    teamId: null,
    isTeamLeader: false,
    permissions: new Map(scope === null ? [] : [[PERMISSIONS.REPORTS_VIEW, scope]]),
    locationIds: [],
    audit: { tenantId: 'tenant-1', actorId: 'user-1', actorType: 'user', requestId: 'req-1' },
  };
}

async function refusal(run: Promise<unknown>): Promise<DomainError> {
  try {
    await run;
    return expect.unreachable('the dashboard must refuse this caller');
  }
  catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
}

describe('which dashboard a caller gets is decided by their grant', () => {
  it('refuses the tenant-wide dashboard to an admin narrowed to areas', async () => {
    const error = await refusal(service.adminDashboard(caller('admin', 'LOCATION')));

    expect(error.statusCode).toBe(403);
    expect(error.code).toBe(ERROR_CODES.PERM_SCOPE_DENIED);
  });

  it('refuses the scoped dashboard to anyone holding the tenant, whatever their role', async () => {
    const error = await refusal(service.staffDashboard(caller('staff', 'ALL')));

    expect(error.statusCode).toBe(403);
    expect(error.code).toBe(ERROR_CODES.PERM_SCOPE_DENIED);
  });

  it('refuses both to a caller who does not hold reports.view at all', async () => {
    for (const run of [service.adminDashboard(caller('admin', null)), service.staffDashboard(caller('staff', null))]) {
      const error = await refusal(run);

      expect(error.statusCode).toBe(403);
      expect(error.code).toBe(ERROR_CODES.PERM_DENIED);
    }
  });
});

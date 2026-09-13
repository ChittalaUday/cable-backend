import type { AuditJson } from '@/db/schema';

export interface AuditContext {
  tenantId: string | null;
  actorId: string | null;
  actorSessionId?: string | null;
  actorType: string;
  requestId?: string | null;
  correlationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * The context for a change nobody requested — a scheduled job, a migration.
 *
 * `actorType: 'system'` is what separates "the nightly job deleted this" from
 * "a person deleted this" when someone asks why a file is gone.
 */
export function systemAuditContext(source: string): AuditContext {
  return {
    tenantId: null,
    actorId: null,
    actorType: 'system',
    requestId: source,
  };
}

export interface AuditEvent {
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  changes?: AuditJson | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditMutation {
  entityType: string;
  entityId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AuditCursor {
  createdAt: Date;
  id: string;
}

export interface AuditQuery {
  tenantId: string | null;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  before?: AuditCursor;
  limit?: number;
}

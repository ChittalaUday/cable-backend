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
  /** Required even for platform events: null explicitly means no tenant. */
  tenantId: string | null;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  before?: AuditCursor;
  limit?: number;
}

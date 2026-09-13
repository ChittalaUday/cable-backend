import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { audit } from '../schemas';

export type AuditJson = Record<string, unknown>;

/** Append-only business history. Application code never updates or deletes these rows. */
export const auditLogs = audit.table('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'),
  actorId: uuid('actor_id'),
  actorSessionId: uuid('actor_session_id'),
  actorType: text('actor_type').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  oldValues: jsonb('old_values').$type<AuditJson>(),
  newValues: jsonb('new_values').$type<AuditJson>(),
  changes: jsonb('changes').$type<AuditJson>(),
  requestId: text('request_id'),
  correlationId: text('correlation_id'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  metadata: jsonb('metadata').$type<AuditJson>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('audit_logs_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('audit_logs_tenant_entity_created_idx').on(table.tenantId, table.entityType, table.entityId, table.createdAt.desc()),
  index('audit_logs_tenant_actor_created_idx').on(table.tenantId, table.actorId, table.createdAt.desc()),
]);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

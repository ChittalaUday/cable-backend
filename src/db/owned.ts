import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { and, eq, isNull } from 'drizzle-orm';

export interface TenantScoped {
  id: PgColumn;
  tenantId: PgColumn;
  deletedAt?: PgColumn;
}

export function owned(table: TenantScoped, tenantId: string, id: string): SQL {
  return and(
    eq(table.tenantId, tenantId),
    eq(table.id, id),
    table.deletedAt === undefined ? undefined : isNull(table.deletedAt),
  )!;
}

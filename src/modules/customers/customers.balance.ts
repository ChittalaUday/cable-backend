import type { Transaction } from '@/db/client';
import { sql } from 'drizzle-orm';

export interface LockedCustomer extends Record<string, unknown> {
  id: string;
  name: string | null;
  customerCode: string | null;
  userId: string | null;
  outstandingBalance: string;
}

export interface CollectableLine extends Record<string, unknown> {
  id: string;
  serviceId: string;
  serviceAccountNumber: string;
  installationLocationId: string;
  outstandingBalance: string;
}

export async function lockCustomer(
  tx: Transaction,
  tenantId: string,
  customerId: string,
): Promise<LockedCustomer | null> {
  const { rows } = await tx.execute<LockedCustomer>(sql`
    SELECT id, name, customer_code "customerCode", user_id "userId", outstanding_balance "outstandingBalance"
    FROM crm.customers
    WHERE id = ${customerId} AND tenant_id = ${tenantId} AND deleted_at IS NULL
    FOR UPDATE
  `);

  return rows[0] ?? null;
}

export async function findCollectableLine(
  tx: Transaction,
  tenantId: string,
  customerId: string,
  subscriptionId: string | null,
): Promise<CollectableLine[]> {
  const { rows } = await tx.execute<CollectableLine>(sql`
    SELECT s.id,
           p.service_id "serviceId",
           s.service_account_number "serviceAccountNumber",
           s.installation_location_id "installationLocationId",
           s.outstanding_balance "outstandingBalance"
    FROM crm.subscriptions s
    JOIN crm.service_providers p ON p.id = s.service_provider_id
    WHERE s.customer_id = ${customerId}
      AND s.tenant_id = ${tenantId}
      AND s.deleted_at IS NULL
      AND (${subscriptionId}::uuid IS NULL OR s.id = ${subscriptionId}::uuid)
    ORDER BY s.created_at
  `);

  return rows;
}

export async function applyDuesPayment(
  tx: Transaction,
  tenantId: string,
  customerId: string,
  subscriptionId: string,
  amount: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE crm.subscriptions
    SET outstanding_balance = outstanding_balance - ${amount}::numeric, updated_at = now()
    WHERE id = ${subscriptionId} AND tenant_id = ${tenantId}
  `);

  await tx.execute(sql`
    UPDATE crm.customers
    SET outstanding_balance = outstanding_balance - ${amount}::numeric, updated_at = now()
    WHERE id = ${customerId} AND tenant_id = ${tenantId}
  `);
}

import { CUSTOMER_SEQ_PAD } from '@/config/constants';

/**
 * Format a customer's public code from its tenant prefix and sequence (§8.1).
 *
 * The sequence comes from `UPDATE tenants SET customer_seq = customer_seq + 1
 * ... RETURNING` inside the insert transaction — never a trigger, and never
 * `SELECT max(...) + 1`, which is a race that hands two customers one code.
 *
 * Past the padding width the number simply grows. It is never truncated or
 * wrapped: a reused code is worse than a long one.
 */
export function formatCustomerCode(tenantCode: string, seq: number): string {
  return `${tenantCode}-${String(seq).padStart(CUSTOMER_SEQ_PAD, '0')}`;
}

/**
 * Numeric suffix of an existing code, or null when it has none.
 *
 * Used by the Firestore import (§9) to park `tenants.customer_seq` above every
 * imported code, so newly created customers cannot collide with one.
 */
export function parseCustomerCodeSeq(code: string): number | null {
  const digits = /-(\d+)$/.exec(code)?.[1];
  if (digits == null || digits === '')
    return null;

  const seq = Number.parseInt(digits, 10);
  return Number.isSafeInteger(seq) ? seq : null;
}

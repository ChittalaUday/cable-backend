import { CUSTOMER_SEQ_PAD } from '@/config/constants';

export function formatCustomerCode(tenantCode: string, seq: number): string {
  return `${tenantCode}-${String(seq).padStart(CUSTOMER_SEQ_PAD, '0')}`;
}

export function parseCustomerCodeSeq(code: string): number | null {
  const digits = /-(\d+)$/.exec(code)?.[1];
  if (digits == null || digits === '')
    return null;

  const seq = Number.parseInt(digits, 10);
  return Number.isSafeInteger(seq) ? seq : null;
}

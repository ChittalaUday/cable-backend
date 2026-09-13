import type { AuditJson } from '@/db/schema';
import { isDeepStrictEqual } from 'node:util';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PARTS = [
  'password',
  'token',
  'secret',
  'otp',
  'codehash',
  'apikey',
  'privatekey',
  'authorization',
  'cookie',
  'googlesub',
] as const;

function keyForComparison(key: string): string {
  return key.replaceAll(/[-_]/g, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = keyForComparison(key);
  return SENSITIVE_KEY_PARTS.some(part => normalized.includes(part));
}

function jsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : null;
  if (value instanceof Date)
    return value.toISOString();
  if (Array.isArray(value))
    return value.map(item => item === undefined ? null : jsonValue(item));
  if (typeof value !== 'object')
    return String(value);

  const result: AuditJson = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined)
      continue;
    result[key] = isSensitiveKey(key) ? REDACTED : jsonValue(item);
  }
  return result;
}

export function sanitizeAuditValue(value: Record<string, unknown> | null | undefined): AuditJson | null {
  return value == null ? null : jsonValue(value) as AuditJson;
}

export function auditDiff(before: AuditJson, after: AuditJson): AuditJson {
  const changes: AuditJson = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldValue = before[key] ?? null;
    const newValue = after[key] ?? null;
    if (!isDeepStrictEqual(oldValue, newValue))
      changes[key] = { old: oldValue, new: newValue };
  }
  return changes;
}

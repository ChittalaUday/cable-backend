import { describe, expect, it } from 'vitest';
import { auditDiff, sanitizeAuditValue } from './audit.utils';

describe('audit values', () => {
  it('redacts nested project credentials and normalizes dates', () => {
    expect(sanitizeAuditValue({
      passwordHash: 'hash',
      nested: { refresh_token_hash: 'hash', sessionToken: 'token', safe: 'yes' },
      at: new Date('2026-01-02T03:04:05.000Z'),
    })).toEqual({
      passwordHash: '[REDACTED]',
      nested: { refresh_token_hash: '[REDACTED]', sessionToken: '[REDACTED]', safe: 'yes' },
      at: '2026-01-02T03:04:05.000Z',
    });
  });

  it('reports changed fields, including both null directions', () => {
    expect(auditDiff(
      { same: ['x'], added: null, removed: 'old', unchanged: { x: 1 } },
      { same: ['x'], added: 'new', removed: null, unchanged: { x: 1 } },
    )).toEqual({
      added: { old: null, new: 'new' },
      removed: { old: 'old', new: null },
    });
  });
});

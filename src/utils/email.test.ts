import { describe, expect, it } from 'vitest';
import { normaliseEmail } from './email';

describe('normaliseEmail', () => {
  it('lowercases and trims, so one address has one spelling', () => {
    expect(normaliseEmail('  Ravi.Kumar@Example.COM ')).toBe('ravi.kumar@example.com');
  });

  it('leaves an address that is already canonical alone', () => {
    expect(normaliseEmail('ravi@example.com')).toBe('ravi@example.com');
  });

  it('answers null for nothing, rather than an address that is the empty string', () => {
    expect(normaliseEmail('   ')).toBeNull();
    expect(normaliseEmail('')).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
    expect(normaliseEmail(undefined)).toBeNull();
  });

  it('is idempotent — running it twice is running it once', () => {
    const once = normaliseEmail(' A@B.Com ');

    expect(normaliseEmail(once)).toBe(once);
  });
});

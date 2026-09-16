import { describe, expect, it } from 'vitest';
import { formatCustomerCode, parseCustomerCodeSeq } from './customer-code';
import { deriveTenantCode, isValidTenantCode, nextAvailableTenantCode } from './tenant-code';

describe('deriveTenantCode', () => {
  it.each([
    ['Satya Cable & Broadband', 'SCB'],
    ['Satyanet', 'SAT'],
    ['The Star Vision Network Pvt Ltd', 'SVN'],
    ['A1 Cable', 'AC'],
    ['4K Vision', 'KV'],
    ['  spaced   out  name ', 'SON'],
    ['Ashok Digital Network Services Extra', 'ADNS'],
  ])('derives %j to %j', (name, expected) => {
    expect(deriveTenantCode(name)).toBe(expected);
  });

  it('drops accents rather than failing on them', () => {
    expect(deriveTenantCode('Sátya Cáble')).toBe('SC');
  });

  it('returns null when nothing usable survives, instead of inventing a code', () => {
    expect(deriveTenantCode('श्री')).toBeNull();
    expect(deriveTenantCode('')).toBeNull();
    expect(deriveTenantCode('   ')).toBeNull();
    expect(deriveTenantCode('Ltd Pvt The')).toBeNull();
  });

  it('returns null for a single letter, which is too short to be a prefix', () => {
    expect(deriveTenantCode('X')).toBeNull();
  });

  it('never returns a code starting with a digit', () => {
    const code = deriveTenantCode('4K Vision');
    expect(code).not.toBeNull();
    expect(code![0]).toMatch(/[A-Z]/);
  });

  it('caps initials at four characters', () => {
    expect(deriveTenantCode('One Two Three Four Five Six')).toBe('OTTF');
  });
});

describe('nextAvailableTenantCode', () => {
  it('returns the base when it is free', () => {
    expect(nextAvailableTenantCode('SCB', new Set())).toBe('SCB');
  });

  it('suffixes on collision', () => {
    expect(nextAvailableTenantCode('SCB', new Set(['SCB']))).toBe('SCB2');
    expect(nextAvailableTenantCode('SCB', new Set(['SCB', 'SCB2', 'SCB3']))).toBe('SCB4');
  });

  it('returns null when every variant is taken, so the caller can ask for one', () => {
    const taken = new Set(['SCB', ...Array.from({ length: 8 }, (_, i) => `SCB${i + 2}`)]);
    expect(nextAvailableTenantCode('SCB', taken)).toBeNull();
  });

  it('never emits a variant that overflows the code pattern', () => {
    expect(nextAvailableTenantCode('ABCDE', new Set(['ABCDE']))).toBeNull();
  });
});

describe('isValidTenantCode', () => {
  it.each(['SC', 'SCB', 'ABCDE', 'A1B2C'])('accepts %j', (code) => {
    expect(isValidTenantCode(code)).toBe(true);
  });

  it.each(['S', 'ABCDEF', '1AB', 'scb', 'S-B', ''])('rejects %j', (code) => {
    expect(isValidTenantCode(code)).toBe(false);
  });
});

describe('formatCustomerCode', () => {
  it('zero-pads to six digits', () => {
    expect(formatCustomerCode('SCB', 1)).toBe('SCB-000001');
    expect(formatCustomerCode('SCB', 123)).toBe('SCB-000123');
    expect(formatCustomerCode('SCB', 999_999)).toBe('SCB-999999');
  });

  it('grows past the padding rather than truncating — a reused code is worse than a long one', () => {
    expect(formatCustomerCode('SCB', 1_000_000)).toBe('SCB-1000000');
  });
});

describe('parseCustomerCodeSeq', () => {
  it('reads the numeric suffix', () => {
    expect(parseCustomerCodeSeq('SCB-000123')).toBe(123);
    expect(parseCustomerCodeSeq('SAT-98765')).toBe(98_765);
  });

  it('returns null when there is no numeric suffix', () => {
    expect(parseCustomerCodeSeq('SAT-ABC')).toBeNull();
    expect(parseCustomerCodeSeq('NOPREFIX')).toBeNull();
    expect(parseCustomerCodeSeq('')).toBeNull();
  });
});

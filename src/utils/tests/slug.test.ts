import { describe, expect, it } from 'vitest';
import { slugify, uniqueSlug } from '../slug';

const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

describe('slugify', () => {
  it('produces a wire-valid slug from a display name', () => {
    expect(slugify('Basic Pack')).toBe('basic-pack');
    expect(slugify('  ACT Fibernet — 100 Mbps!  ')).toBe('act-fibernet-100-mbps');
    expect(slugify('Śrī Sai')).toBe('sri-sai');
  });

  it('never returns something the schema would reject', () => {
    for (const name of ['!!!', '---', 'तारा', 'a'.repeat(200), 'Ends with symbol —'])
      expect(slugify(name)).toMatch(SLUG_PATTERN);
  });
});

describe('uniqueSlug', () => {
  it('returns the plain slug when nothing has claimed it', () => {
    expect(uniqueSlug('Basic Pack', [])).toBe('basic-pack');
  });

  it('walks past every taken variant', () => {
    expect(uniqueSlug('Basic Pack', ['basic-pack'])).toBe('basic-pack-2');
    expect(uniqueSlug('Basic Pack', ['basic-pack', 'basic-pack-2'])).toBe('basic-pack-3');
  });

  it('keeps the suffixed form inside 60 characters and valid', () => {
    const long = 'A'.repeat(80);
    const slug = uniqueSlug(long, [slugify(long)]);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toMatch(SLUG_PATTERN);
  });
});

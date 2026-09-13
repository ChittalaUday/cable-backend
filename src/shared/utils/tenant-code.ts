import { TENANT_CODE_PATTERN } from '@/config/constants';

/** Words that carry no identity and would only dilute the prefix. */
const NOISE_WORDS = new Set([
  'AND',
  'THE',
  'OF',
  'PVT',
  'PRIVATE',
  'LTD',
  'LIMITED',
  'LLP',
  'INC',
  'CO',
  'CORP',
  'CORPORATION',
]);

const MAX_INITIALS = 4;

/**
 * Derive a tenant's public prefix from its name (AGENTS.md §8.1).
 *
 * Pure — no database access, so it is trivially testable. Uniqueness is the
 * caller's problem: see `nextAvailableTenantCode`.
 *
 * Returns null when the name cannot produce a usable prefix. The caller then
 * asks the operator for one rather than inventing something unrecognisable —
 * an identifier no human recognises defeats the point of having a public code.
 */
export function deriveTenantCode(name: string): string | null {
  const words = name
    .normalize('NFD')
    // Strip combining accents, then anything outside A-Z, 0-9 and spaces.
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    // Leading digits are dropped per word, so `4K Vision` initials to `KV`
    // rather than `4V` — a code reading like a quantity is not a name.
    .map(word => word.replace(/^\d+/, ''))
    .filter(word => word.length > 0 && !NOISE_WORDS.has(word));

  if (words.length === 0)
    return null;

  const code = words.length >= 2
    ? words.slice(0, MAX_INITIALS).map(word => word[0]).join('')
    : (words[0] ?? '').slice(0, 3);

  return TENANT_CODE_PATTERN.test(code) ? code : null;
}

/**
 * First unused variant of a derived code: `SCB`, then `SCB2` … `SCB9`.
 *
 * Returns null when every variant is taken — the caller surfaces
 * `TENANT_CODE_UNAVAILABLE` and asks for an explicit code.
 */
export function nextAvailableTenantCode(base: string, taken: ReadonlySet<string>): string | null {
  if (!taken.has(base))
    return base;

  for (let suffix = 2; suffix <= 9; suffix += 1) {
    const candidate = `${base}${suffix}`;
    // A 5-character base plus a suffix would overflow the pattern.
    if (TENANT_CODE_PATTERN.test(candidate) && !taken.has(candidate))
      return candidate;
  }

  return null;
}

/** True when an operator-supplied code is acceptable. */
export function isValidTenantCode(code: string): boolean {
  return TENANT_CODE_PATTERN.test(code);
}

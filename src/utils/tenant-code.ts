import { TENANT_CODE_PATTERN } from '@/config/constants';

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

export function deriveTenantCode(name: string): string | null {
  const words = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(word => word.replace(/^\d+/, ''))
    .filter(word => word.length > 0 && !NOISE_WORDS.has(word));

  if (words.length === 0)
    return null;

  const code = words.length >= 2
    ? words.slice(0, MAX_INITIALS).map(word => word[0]).join('')
    : (words[0] ?? '').slice(0, 3);

  return TENANT_CODE_PATTERN.test(code) ? code : null;
}

export function nextAvailableTenantCode(base: string, taken: ReadonlySet<string>): string | null {
  if (!taken.has(base))
    return base;

  for (let suffix = 2; suffix <= 9; suffix += 1) {
    const candidate = `${base}${suffix}`;
    if (TENANT_CODE_PATTERN.test(candidate) && !taken.has(candidate))
      return candidate;
  }

  return null;
}

export function isValidTenantCode(code: string): boolean {
  return TENANT_CODE_PATTERN.test(code);
}

import process from 'node:process';

/** Fixtures the seeder writes and the runner logs in as. */
export const STRESS_TENANT_CODE = 'SSCN';
export const STRESS_PASSWORD = 'Stress@123456';
export const STRESS_EMAIL_DOMAIN = 'loadtest.local';

/** Deterministic, so re-seeding reuses the same accounts instead of piling up new ones. */
export function stressEmail(index: number): string {
  return `stress-${String(index + 1).padStart(4, '0')}@${STRESS_EMAIL_DOMAIN}`;
}

export function arg(name: string, fallback: string): string {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

export function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

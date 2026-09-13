import process from 'node:process';

/**
 * Connection string for the test database, or a loud failure.
 *
 * Never falls back to a local or production database: a test that quietly runs
 * somewhere else is worse than a test that does not run.
 */
export function requireTestDatabase(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (url == null || url === '') {
    throw new Error(
      'No test database. Start Docker so Testcontainers can boot PostgreSQL 18, '
      + 'or set DATABASE_URL_TEST to an existing one.',
    );
  }
  return url;
}

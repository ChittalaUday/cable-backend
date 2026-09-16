import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLogCleanupJob } from '@/jobs/log-cleanup.job';
import { createRotatingLogDestination } from './logger';

describe('local log storage', () => {
  it('groups, rotates, and deletes logs by UTC date', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cable-logs-'));
    const destination = createRotatingLogDestination({
      directory,
      maxFileBytes: 12,
      name: 'api',
      now: () => new Date('2026-09-13T12:00:00Z'),
    });

    destination.write('123456\n');
    destination.write('abcdef\n');
    const current = path.join(directory, '2026-09-13');
    const files = readdirSync(current);
    expect(files).toHaveLength(2);
    expect(files.map(file => readFileSync(path.join(current, file), 'utf8'))).toEqual(['123456\n', 'abcdef\n']);

    const expired = path.join(directory, '2026-08-01');
    await mkdir(expired);
    await writeFile(path.join(expired, 'old.log'), 'old');
    await runLogCleanupJob({ directory, retentionDays: 30, now: new Date('2026-09-13T12:00:00Z') });

    expect(readdirSync(directory)).toEqual(['2026-09-13']);
  });

  it('keeps 1 log file for a day across restarts and rotates only when size exceeds limit', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cable-logs-'));
    const now = () => new Date('2026-09-13T12:00:00Z');

    const dest1 = createRotatingLogDestination({
      directory,
      maxFileBytes: 50,
      name: 'api',
      now,
    });
    dest1.write('first session log line\n');

    const dest2 = createRotatingLogDestination({
      directory,
      maxFileBytes: 50,
      name: 'api',
      now,
    });
    dest2.write('second session log line\n');

    const dayDir = path.join(directory, '2026-09-13');
    let files = readdirSync(dayDir).sort();
    expect(files).toEqual(['api-1.log']);
    expect(readFileSync(path.join(dayDir, 'api-1.log'), 'utf8')).toBe(
      'first session log line\nsecond session log line\n',
    );

    dest2.write('third log line that pushes total bytes over the 50 byte limit\n');

    files = readdirSync(dayDir).sort();
    expect(files).toEqual(['api-1.log', 'api-2.log']);
    expect(readFileSync(path.join(dayDir, 'api-2.log'), 'utf8')).toBe(
      'third log line that pushes total bytes over the 50 byte limit\n',
    );
  });
});

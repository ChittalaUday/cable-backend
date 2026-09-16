import type { FastifyBaseLogger } from 'fastify';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

interface LogCleanupOptions {
  directory: string;
  retentionDays: number;
  log?: Pick<FastifyBaseLogger, 'info'>;
  now?: Date;
}

export async function runLogCleanupJob(options: LogCleanupOptions): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - options.retentionDays))
    .toISOString()
    .slice(0, 10);
  const directory = path.resolve(options.directory);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw error;
  });
  const expired = entries.filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < cutoff);

  await Promise.all(expired.map(async entry => rm(path.join(directory, entry.name), { recursive: true })));
  options.log?.info({ deletedFolders: expired.length, cutoff }, '[job:log-cleanup] Deleted expired local logs');
  return expired.length;
}

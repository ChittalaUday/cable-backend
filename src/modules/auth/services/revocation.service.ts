import type pg from 'pg';
import type { Database } from '@/db/client';
import { SessionsRepository } from '../repositories/sessions.repository';

const CHANNEL = 'session_revoked';

export class RevocationCache {
  private readonly revoked = new Map<string, number>();
  private readonly repo: SessionsRepository;
  private listener: pg.PoolClient | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(
    repoOrDb: SessionsRepository | Database,
    private readonly pool: pg.Pool,
    private readonly ttlMs: number,
  ) {
    this.repo = repoOrDb instanceof SessionsRepository ? repoOrDb : new SessionsRepository(repoOrDb);
  }

  has(sessionId: string): boolean {
    return this.revoked.has(sessionId);
  }

  async publish(sessionId: string): Promise<void> {
    this.add(sessionId);
    await this.repo.notifyRevoked(CHANNEL, sessionId);
  }

  async start(): Promise<void> {
    await this.load().catch(() => {});

    this.listener = await this.pool.connect();
    this.listener.on('notification', (message) => {
      if (message.channel === CHANNEL && message.payload != null && message.payload !== '')
        this.add(message.payload);
    });
    await this.listener.query(`LISTEN ${CHANNEL}`);

    this.pruneTimer = setInterval(() => this.prune(), this.ttlMs);
    this.pruneTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.pruneTimer)
      clearInterval(this.pruneTimer);

    this.listener?.release();
    this.listener = null;
  }

  private async load(): Promise<void> {
    for (const id of await this.repo.revokedSince(new Date(Date.now() - this.ttlMs)))
      this.add(id);
  }

  private add(sessionId: string): void {
    this.revoked.set(sessionId, Date.now());
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, at] of this.revoked) {
      if (at < cutoff)
        this.revoked.delete(id);
    }
  }
}

import type pg from 'pg';
import type { Database } from '@/plugins/database';
import { sql } from 'drizzle-orm';

const CHANNEL = 'session_revoked';

/**
 * Per-request session revocation (AGENTS.md §4.6).
 *
 * Access tokens are short-lived JWTs, so "revoked" has to mean something
 * enforced on every request rather than only at refresh time.
 *
 * The set holds sessions revoked within the last access-token TTL — after that
 * the token has expired anyway, so entries are dropped and the set stays small
 * however long the process runs.
 *
 * Instances stay in sync over Postgres `LISTEN/NOTIFY`. No Redis (§1): Postgres
 * already does pub/sub, and it is the one datastore this service has.
 *
 * Rejected alternative: querying `sessions` on every request. One indexed lookup
 * is cheap in isolation, but it puts the database on the critical path of every
 * authenticated request — including reads that would not otherwise touch it —
 * and it fails closed exactly when the database is already struggling.
 */
export class RevocationCache {
  private readonly revoked = new Map<string, number>();
  private listener: pg.PoolClient | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly pool: pg.Pool,
    private readonly ttlMs: number,
  ) {}

  has(sessionId: string): boolean {
    return this.revoked.has(sessionId);
  }

  /** Called by whatever revokes a session, so this instance is correct immediately. */
  async publish(sessionId: string): Promise<void> {
    this.add(sessionId);
    await this.db.execute(sql`SELECT pg_notify(${CHANNEL}, ${sessionId})`);
  }

  async start(): Promise<void> {
    await this.load();

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

  /** Warm start: a redeploy must not resurrect sessions revoked moments ago. */
  private async load(): Promise<void> {
    const cutoff = new Date(Date.now() - this.ttlMs);
    const rows = await this.db.execute<{ id: string }>(
      sql`SELECT id FROM auth.sessions WHERE revoked_at IS NOT NULL AND revoked_at > ${cutoff}`,
    );

    for (const row of rows.rows)
      this.add(row.id);
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

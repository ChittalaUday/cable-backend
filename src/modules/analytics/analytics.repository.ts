import type { SQL } from 'drizzle-orm';
import type { Database } from '@/db/client';

export type CountRow = Record<string, string | number | null>;

export class AnalyticsRepository {
  constructor(private readonly db: Database) {}

  async executeQuery<T extends Record<string, unknown> = CountRow>(query: SQL): Promise<T[]> {
    const result = await this.db.execute<T>(query);
    return result as unknown as T[];
  }
}

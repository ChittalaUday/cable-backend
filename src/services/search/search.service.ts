import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

export interface SearchOptions {
  threshold?: number;
}

export class SearchService {
  fuzzyMatch(column: SQL | unknown, query: string, weight = 1.0): SQL {
    return sql`similarity(${column}, ${query}) * ${weight}`;
  }

  likeMatch(column: SQL | unknown, pattern: string): SQL {
    return sql`${column} ILIKE ${pattern}`;
  }
}

export const searchService = new SearchService();

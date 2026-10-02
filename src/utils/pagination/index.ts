import type { Static, TSchema } from 'typebox';
import { Type } from 'typebox';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/config/constants';

export const PaginationQuerySchema = Type.Object({
  page: Type.Integer({ minimum: 1, maximum: 1_000_000, default: 1 }),
  limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
});

export type PaginationQuery = Static<typeof PaginationQuerySchema>;

export function paginated<T extends TSchema>(item: T) {
  return Type.Object({
    items: Type.Array(item),
    total: Type.Integer(),
    page: Type.Integer(),
    limit: Type.Integer(),
  });
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export function offsetOf({ page, limit }: PaginationQuery): number {
  return (page - 1) * limit;
}

export async function pageOf<Row, Item>(
  query: PaginationQuery,
  source: {
    rows: PromiseLike<Row[]>;
    totals: PromiseLike<{ total: number }[]>;
    present: (rows: Row[]) => Item[] | Promise<Item[]>;
  },
): Promise<Page<Item>> {
  const [rows, [counted]] = await Promise.all([source.rows, source.totals]);

  return {
    items: await source.present(rows),
    total: counted?.total ?? 0,
    page: query.page,
    limit: query.limit,
  };
}

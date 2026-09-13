import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/config/constants';

/**
 * Shared list query (AGENTS.md §6).
 *
 * The `limit` ceiling is enforced by `maximum` in the schema, not by code in a
 * service — Fastify rejects an over-large page before a handler ever runs.
 */
export const PaginationQuerySchema = Type.Object({
  page: Type.Integer({ minimum: 1, default: 1 }),
  limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
});

export type PaginationQuery = Static<typeof PaginationQuerySchema>;

/**
 * List envelope. Success responses carry no envelope (§6); lists are the one
 * exception, because pagination metadata has nowhere else to go.
 */
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

/** Rows to skip for a 1-based page. */
export function offsetOf({ page, limit }: PaginationQuery): number {
  return (page - 1) * limit;
}

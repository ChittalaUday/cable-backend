import { sql } from 'drizzle-orm';
import { check, text, timestamp } from 'drizzle-orm/pg-core';
import { iam } from '../schemas';

export const roles = iam.table('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('roles_known_id', sql`${table.id} IN ('admin', 'staff', 'customer')`),
]);

export type Role = typeof roles.$inferSelect;

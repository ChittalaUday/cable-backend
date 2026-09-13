import { sql } from 'drizzle-orm';
import { check, index, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { auth } from '../schemas';

export const users = auth.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),

  customerCode: text('customer_code').unique(),

  email: text('email').unique(),

  phone: varchar('phone', { length: 10 }).unique(),

  passwordHash: text('password_hash'),
  googleSub: text('google_sub').unique(),

  name: text('name'),
  photoUrl: text('photo_url'),

  disabledAt: timestamp('disabled_at', { withTimezone: true }),

  credentialsChangedAt: timestamp('credentials_changed_at', { withTimezone: true }).notNull().defaultNow(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('users_identifier_present', sql`${table.email} IS NOT NULL OR ${table.phone} IS NOT NULL`),
  check('users_phone_ten_digits', sql`${table.phone} IS NULL OR ${table.phone} ~ '^[0-9]{10}$'`),
  index('users_disabled_at_idx').on(table.disabledAt),
]);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

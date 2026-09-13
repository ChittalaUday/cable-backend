import { boolean, index, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { crm } from '../schemas';
import { channels } from './channels';
import { packages } from './packages';

export const packageChannels = crm.table('package_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  packageId: uuid('package_id').notNull().references(() => packages.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),

  isMandatory: boolean('is_mandatory').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('package_channels_pkg_channel_unq').on(table.packageId, table.channelId),
  index('package_channels_package_idx').on(table.packageId),
  index('package_channels_channel_idx').on(table.channelId),
]);

export type PackageChannel = typeof packageChannels.$inferSelect;
export type NewPackageChannel = typeof packageChannels.$inferInsert;

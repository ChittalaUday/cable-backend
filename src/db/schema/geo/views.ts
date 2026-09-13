import { integer, text, uuid } from 'drizzle-orm/pg-core';
import { geo } from '../schemas';

export const locationPaths = geo.view('location_paths', {
  id: uuid('id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  rootId: uuid('root_id').notNull(),
  depth: integer('depth').notNull(),
  pathIds: uuid('path_ids').array().notNull(),
  path: text('path').notNull(),
}).existing();

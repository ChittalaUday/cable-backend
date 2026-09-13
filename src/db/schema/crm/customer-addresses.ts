import { boolean, index, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { customers } from './customers';

/**
 * Granular physical addresses for subscribers (installation, billing).
 *
 * Separated into its own table so addresses can be independently indexed,
 * searched, and filtered by apartment, building, landmark, area, or pincode.
 */
export const customerAddresses = crm.table('customer_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),

  addressType: text('address_type', { enum: ['installation', 'billing', 'home', 'office'] }).notNull().default('installation'),

  flatOrDoorNo: text('flat_or_door_no'),
  buildingOrApartment: text('building_or_apartment'),
  streetOrRoad: text('street_or_road'),
  landmark: text('landmark'),
  area: text('area'),
  city: text('city'),
  district: text('district'),
  state: text('state').default('Andhra Pradesh'),
  pincode: text('pincode'),

  latitude: numeric('latitude', { precision: 10, scale: 7 }),
  longitude: numeric('longitude', { precision: 10, scale: 7 }),

  isPrimary: boolean('is_primary').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('cust_addr_tenant_cust_idx').on(table.tenantId, table.customerId),
  index('cust_addr_building_idx').on(table.tenantId, table.buildingOrApartment),
  index('cust_addr_landmark_idx').on(table.tenantId, table.landmark),
  index('cust_addr_city_idx').on(table.tenantId, table.city),
  index('cust_addr_pincode_idx').on(table.tenantId, table.pincode),
  index('cust_addr_area_idx').on(table.tenantId, table.area),
]);

export type CustomerAddress = typeof customerAddresses.$inferSelect;
export type NewCustomerAddress = typeof customerAddresses.$inferInsert;

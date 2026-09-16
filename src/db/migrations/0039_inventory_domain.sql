CREATE SCHEMA IF NOT EXISTS "inventory";
--> statement-breakpoint
DROP TABLE IF EXISTS "crm"."customer_equipment" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "crm"."equipment" CASCADE;
--> statement-breakpoint
CREATE TABLE "inventory"."item_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"icon" text,
	"description" text,
	"is_serialized" boolean DEFAULT false NOT NULL,
	"is_returnable" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_types_tenant_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "inventory"."item_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_type_id" uuid,
	"name" text NOT NULL,
	"code" text,
	"brand" text,
	"model" text,
	"icon" text,
	"description" text,
	"tracking_type" text DEFAULT 'serialized' NOT NULL,
	"is_bundle" boolean DEFAULT false NOT NULL,
	"default_ownership" text DEFAULT 'tenant_provided' NOT NULL,
	"default_sale_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"default_deposit_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"default_rental_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"is_returnable" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_catalog_tenant_code_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "inventory"."bundle_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bundle_catalog_id" uuid NOT NULL,
	"component_catalog_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bundle_items_unique_component" UNIQUE("tenant_id","bundle_catalog_id","component_catalog_id")
);
--> statement-breakpoint
CREATE TABLE "inventory"."equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"catalog_id" uuid,
	"parent_equipment_id" uuid,
	"location_id" uuid,
	"staff_id" uuid,
	"serial_number" text,
	"vc_number" text,
	"mac_address" text,
	"barcode" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"ownership_type" text DEFAULT 'tenant_provided' NOT NULL,
	"deposit_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"cost_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"is_returnable" boolean DEFAULT true NOT NULL,
	"inventory_status" text DEFAULT 'available' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory"."customer_equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ownership_type" text DEFAULT 'tenant_provided' NOT NULL,
	"charged_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"deposit_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid,
	"returned_at" timestamp with time zone,
	"return_condition" text,
	"collected_by" uuid,
	"refunded_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"return_remarks" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"movement_type" text NOT NULL,
	"from_location_id" uuid,
	"to_location_id" uuid,
	"from_staff_id" uuid,
	"to_staff_id" uuid,
	"performed_by" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory"."item_types" ADD CONSTRAINT "item_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."item_catalog" ADD CONSTRAINT "item_catalog_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."item_catalog" ADD CONSTRAINT "item_catalog_item_type_id_item_types_id_fk" FOREIGN KEY ("item_type_id") REFERENCES "inventory"."item_types"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."bundle_items" ADD CONSTRAINT "bundle_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."bundle_items" ADD CONSTRAINT "bundle_items_bundle_catalog_id_item_catalog_id_fk" FOREIGN KEY ("bundle_catalog_id") REFERENCES "inventory"."item_catalog"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."bundle_items" ADD CONSTRAINT "bundle_items_component_catalog_id_item_catalog_id_fk" FOREIGN KEY ("component_catalog_id") REFERENCES "inventory"."item_catalog"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."equipment" ADD CONSTRAINT "equipment_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."equipment" ADD CONSTRAINT "equipment_catalog_id_item_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "inventory"."item_catalog"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."equipment" ADD CONSTRAINT "equipment_parent_equipment_id_equipment_id_fk" FOREIGN KEY ("parent_equipment_id") REFERENCES "inventory"."equipment"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."equipment" ADD CONSTRAINT "equipment_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."equipment" ADD CONSTRAINT "equipment_staff_id_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "inventory"."equipment"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "crm"."customers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "crm"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_collected_by_users_id_fk" FOREIGN KEY ("collected_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "inventory"."equipment"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "geo"."locations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "geo"."locations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_from_staff_id_users_id_fk" FOREIGN KEY ("from_staff_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_to_staff_id_users_id_fk" FOREIGN KEY ("to_staff_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "item_types_tenant_idx" ON "inventory"."item_types" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "item_catalog_tenant_idx" ON "inventory"."item_catalog" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "item_catalog_tenant_type_idx" ON "inventory"."item_catalog" USING btree ("tenant_id","item_type_id");
--> statement-breakpoint
CREATE INDEX "item_catalog_search_trgm_idx" ON "inventory"."item_catalog" USING gin ((
  coalesce("name", '') || ' ' || coalesce("code", '') || ' ' ||
  coalesce("brand", '') || ' ' || coalesce("model", '')
) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "bundle_items_tenant_bundle_idx" ON "inventory"."bundle_items" USING btree ("tenant_id","bundle_catalog_id");
--> statement-breakpoint
CREATE INDEX "equipment_tenant_serial_idx" ON "inventory"."equipment" USING btree ("tenant_id","serial_number");
--> statement-breakpoint
CREATE INDEX "equipment_tenant_vc_idx" ON "inventory"."equipment" USING btree ("tenant_id","vc_number");
--> statement-breakpoint
CREATE INDEX "equipment_tenant_mac_idx" ON "inventory"."equipment" USING btree ("tenant_id","mac_address");
--> statement-breakpoint
CREATE INDEX "equipment_tenant_inv_status_idx" ON "inventory"."equipment" USING btree ("tenant_id","inventory_status");
--> statement-breakpoint
CREATE INDEX "equipment_tenant_location_idx" ON "inventory"."equipment" USING btree ("tenant_id","location_id");
--> statement-breakpoint
CREATE INDEX "equipment_tenant_staff_idx" ON "inventory"."equipment" USING btree ("tenant_id","staff_id");
--> statement-breakpoint
CREATE INDEX "equipment_tenant_parent_idx" ON "inventory"."equipment" USING btree ("tenant_id","parent_equipment_id");
--> statement-breakpoint
CREATE INDEX "equipment_tenant_catalog_idx" ON "inventory"."equipment" USING btree ("tenant_id","catalog_id");
--> statement-breakpoint
CREATE INDEX "equipment_search_trgm_idx" ON "inventory"."equipment" USING gin ((
  coalesce("serial_number", '') || ' ' || coalesce("vc_number", '') || ' ' ||
  coalesce("mac_address", '') || ' ' || coalesce("barcode", '')
) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_sub_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","subscription_id");
--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_cust_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","customer_id");
--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_eq_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","equipment_id");
--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_status_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_eq_idx" ON "inventory"."stock_movements" USING btree ("tenant_id","equipment_id");
--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_created_idx" ON "inventory"."stock_movements" USING btree ("tenant_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_type_idx" ON "inventory"."stock_movements" USING btree ("tenant_id","movement_type");

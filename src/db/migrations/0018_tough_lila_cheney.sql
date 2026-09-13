CREATE SCHEMA IF NOT EXISTS "geo";
--> statement-breakpoint
CREATE TABLE "geo"."location_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_categories_tenant_slug_uq" UNIQUE("tenant_id","slug")
);
--> statement-breakpoint
CREATE TABLE "geo"."location_schema_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	"is_terminal" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "location_schema_levels_depth_uq" UNIQUE("schema_id","depth"),
	CONSTRAINT "location_schema_levels_category_uq" UNIQUE("schema_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "geo"."location_schemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_schemas_tenant_slug_uq" UNIQUE("tenant_id","slug")
);
--> statement-breakpoint
CREATE TABLE "geo"."location_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"source" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_aliases_uq" UNIQUE("location_id","alias")
);
--> statement-breakpoint
CREATE TABLE "geo"."locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"schema_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"code" text,
	"source" text DEFAULT 'admin' NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"metadata" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_parent_name_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","parent_id","name"),
	CONSTRAINT "locations_not_own_parent" CHECK (parent_id IS NULL OR parent_id <> id)
);
--> statement-breakpoint
ALTER TABLE "crm"."customer_addresses" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "geo"."location_categories" ADD CONSTRAINT "location_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_schema_levels" ADD CONSTRAINT "location_schema_levels_schema_id_location_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "geo"."location_schemas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_schema_levels" ADD CONSTRAINT "location_schema_levels_category_id_location_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "geo"."location_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_schemas" ADD CONSTRAINT "location_schemas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_aliases" ADD CONSTRAINT "location_aliases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_aliases" ADD CONSTRAINT "location_aliases_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."locations" ADD CONSTRAINT "locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."locations" ADD CONSTRAINT "locations_schema_id_location_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "geo"."location_schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."locations" ADD CONSTRAINT "locations_category_id_location_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "geo"."location_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."locations" ADD CONSTRAINT "locations_parent_id_locations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "geo"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."locations" ADD CONSTRAINT "locations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_aliases_tenant_idx" ON "geo"."location_aliases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "locations_tenant_parent_idx" ON "geo"."locations" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE INDEX "locations_tenant_category_idx" ON "geo"."locations" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "locations_tenant_schema_idx" ON "geo"."locations" USING btree ("tenant_id","schema_id");--> statement-breakpoint
CREATE INDEX "locations_tenant_created_idx" ON "geo"."locations" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "crm"."customer_addresses" ADD CONSTRAINT "customer_addresses_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_area_id_locations_id_fk" FOREIGN KEY ("area_id") REFERENCES "geo"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."membership_areas" ADD CONSTRAINT "membership_areas_area_id_locations_id_fk" FOREIGN KEY ("area_id") REFERENCES "geo"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."membership_locations" ADD CONSTRAINT "membership_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cust_addr_location_idx" ON "crm"."customer_addresses" USING btree ("location_id");
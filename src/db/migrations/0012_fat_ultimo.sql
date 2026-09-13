CREATE TABLE "crm"."customer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_type" text DEFAULT 'installation' NOT NULL,
	"flat_or_door_no" text,
	"building_or_apartment" text,
	"street_or_road" text,
	"landmark" text,
	"area" text,
	"city" text,
	"district" text,
	"state" text DEFAULT 'Andhra Pradesh',
	"pincode" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"is_primary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "crm"."customer_details" CASCADE;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "alternate_phone" varchar(10);--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "whatsapp_number" varchar(10);--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "national_id_type" text;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "national_id_number" text;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "crm"."customer_addresses" ADD CONSTRAINT "customer_addresses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "crm"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cust_addr_tenant_cust_idx" ON "crm"."customer_addresses" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "cust_addr_building_idx" ON "crm"."customer_addresses" USING btree ("tenant_id","building_or_apartment");--> statement-breakpoint
CREATE INDEX "cust_addr_landmark_idx" ON "crm"."customer_addresses" USING btree ("tenant_id","landmark");--> statement-breakpoint
CREATE INDEX "cust_addr_city_idx" ON "crm"."customer_addresses" USING btree ("tenant_id","city");--> statement-breakpoint
CREATE INDEX "cust_addr_pincode_idx" ON "crm"."customer_addresses" USING btree ("tenant_id","pincode");--> statement-breakpoint
CREATE INDEX "cust_addr_area_idx" ON "crm"."customer_addresses" USING btree ("tenant_id","area");--> statement-breakpoint
ALTER TABLE "crm"."customers" DROP COLUMN "address";
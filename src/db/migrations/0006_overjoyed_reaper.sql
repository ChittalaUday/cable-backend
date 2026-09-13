CREATE TABLE "crm"."customer_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"alternate_phone" text,
	"whatsapp_number" text,
	"national_id_type" text,
	"national_id_number" text,
	"flat_or_door_no" text,
	"building_or_apartment" text,
	"landmark" text,
	"city" text,
	"pincode" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_details_cust_unq" UNIQUE("customer_id")
);
--> statement-breakpoint
ALTER TABLE "crm"."customer_details" ADD CONSTRAINT "customer_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customer_details" ADD CONSTRAINT "customer_details_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "crm"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_details_tenant_cust_idx" ON "crm"."customer_details" USING btree ("tenant_id","customer_id");
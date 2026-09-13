CREATE TABLE "crm"."account_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"subscription_id" uuid,
	"service_account_number" text NOT NULL,
	"transaction_no" text NOT NULL,
	"transaction_date" timestamp with time zone NOT NULL,
	"transaction_type" text NOT NULL,
	"remarks" text,
	"debit" numeric(12, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(12, 2) DEFAULT '0' NOT NULL,
	"closing_balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"channel_number" integer,
	"genre" text DEFAULT 'General' NOT NULL,
	"language" text DEFAULT 'Telugu' NOT NULL,
	"resolution" text DEFAULT 'SD' NOT NULL,
	"is_fta" boolean DEFAULT false NOT NULL,
	"broadcaster" text,
	"price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"logo_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."customer_equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
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
CREATE TABLE "crm"."equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"equipment_type" text DEFAULT 'stb' NOT NULL,
	"brand" text,
	"model" text,
	"serial_number" text,
	"vc_number" text,
	"mac_address" text,
	"barcode" text,
	"ownership_type" text DEFAULT 'tenant_provided' NOT NULL,
	"deposit_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"is_returnable" boolean DEFAULT true NOT NULL,
	"inventory_status" text DEFAULT 'available' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."package_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"is_mandatory" boolean DEFAULT true NOT NULL,
	"channel_number_override" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_channels_pkg_channel_unq" UNIQUE("package_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"package_type" text DEFAULT 'base' NOT NULL,
	"price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"mso_share" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '18.00' NOT NULL,
	"billing_cycle" text DEFAULT 'monthly' NOT NULL,
	"description" text,
	"metadata" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm"."services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"service_type" text NOT NULL,
	"provider_name" text,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"service_account_number" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"start_date" timestamp with time zone DEFAULT now() NOT NULL,
	"end_date" timestamp with time zone,
	"billing_cycle" text DEFAULT 'monthly' NOT NULL,
	"price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"installation_address" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "crm"."account_transactions" ADD CONSTRAINT "account_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."account_transactions" ADD CONSTRAINT "account_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "crm"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."account_transactions" ADD CONSTRAINT "account_transactions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "crm"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."channels" ADD CONSTRAINT "channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customer_equipment" ADD CONSTRAINT "customer_equipment_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customer_equipment" ADD CONSTRAINT "customer_equipment_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "crm"."equipment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customer_equipment" ADD CONSTRAINT "customer_equipment_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "crm"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customer_equipment" ADD CONSTRAINT "customer_equipment_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "crm"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customer_equipment" ADD CONSTRAINT "customer_equipment_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customer_equipment" ADD CONSTRAINT "customer_equipment_collected_by_users_id_fk" FOREIGN KEY ("collected_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."equipment" ADD CONSTRAINT "equipment_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."package_channels" ADD CONSTRAINT "package_channels_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "crm"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."package_channels" ADD CONSTRAINT "package_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "crm"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."packages" ADD CONSTRAINT "packages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."packages" ADD CONSTRAINT "packages_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "crm"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "crm"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "crm"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "crm"."packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_tx_tenant_acc_idx" ON "crm"."account_transactions" USING btree ("tenant_id","service_account_number");--> statement-breakpoint
CREATE INDEX "account_tx_tenant_cust_idx" ON "crm"."account_transactions" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "account_tx_tenant_tx_idx" ON "crm"."account_transactions" USING btree ("tenant_id","transaction_no");--> statement-breakpoint
CREATE INDEX "account_tx_tenant_date_idx" ON "crm"."account_transactions" USING btree ("tenant_id","transaction_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "channels_tenant_number_idx" ON "crm"."channels" USING btree ("tenant_id","channel_number");--> statement-breakpoint
CREATE INDEX "channels_tenant_genre_idx" ON "crm"."channels" USING btree ("tenant_id","genre");--> statement-breakpoint
CREATE INDEX "channels_tenant_lang_idx" ON "crm"."channels" USING btree ("tenant_id","language");--> statement-breakpoint
CREATE INDEX "channels_tenant_status_idx" ON "crm"."channels" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_sub_idx" ON "crm"."customer_equipment" USING btree ("tenant_id","subscription_id");--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_cust_idx" ON "crm"."customer_equipment" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_eq_idx" ON "crm"."customer_equipment" USING btree ("tenant_id","equipment_id");--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_status_idx" ON "crm"."customer_equipment" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "equipment_tenant_serial_idx" ON "crm"."equipment" USING btree ("tenant_id","serial_number");--> statement-breakpoint
CREATE INDEX "equipment_tenant_vc_idx" ON "crm"."equipment" USING btree ("tenant_id","vc_number");--> statement-breakpoint
CREATE INDEX "equipment_tenant_mac_idx" ON "crm"."equipment" USING btree ("tenant_id","mac_address");--> statement-breakpoint
CREATE INDEX "equipment_tenant_inv_status_idx" ON "crm"."equipment" USING btree ("tenant_id","inventory_status");--> statement-breakpoint
CREATE INDEX "equipment_tenant_type_idx" ON "crm"."equipment" USING btree ("tenant_id","equipment_type");--> statement-breakpoint
CREATE INDEX "package_channels_package_idx" ON "crm"."package_channels" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "package_channels_channel_idx" ON "crm"."package_channels" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "packages_tenant_service_idx" ON "crm"."packages" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "packages_tenant_slug_idx" ON "crm"."packages" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "packages_tenant_status_idx" ON "crm"."packages" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "services_tenant_status_idx" ON "crm"."services" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "services_tenant_slug_idx" ON "crm"."services" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "services_tenant_type_idx" ON "crm"."services" USING btree ("tenant_id","service_type");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_customer_idx" ON "crm"."subscriptions" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_service_idx" ON "crm"."subscriptions" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_package_idx" ON "crm"."subscriptions" USING btree ("tenant_id","package_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_status_idx" ON "crm"."subscriptions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_account_idx" ON "crm"."subscriptions" USING btree ("tenant_id","service_account_number");--> statement-breakpoint
CREATE OR REPLACE FUNCTION crm.next_customer_code(p_tenant_id uuid)
RETURNS text AS $$
DECLARE
  v_code text;
  v_seq integer;
BEGIN
  UPDATE tenancy.tenants
  SET customer_seq = customer_seq + 1,
      updated_at = now()
  WHERE id = p_tenant_id
  RETURNING code, customer_seq INTO v_code, v_seq;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant not found: %', p_tenant_id;
  END IF;

  RETURN v_code || '-' || lpad(v_seq::text, 6, '0');
END;
$$ LANGUAGE plpgsql VOLATILE;
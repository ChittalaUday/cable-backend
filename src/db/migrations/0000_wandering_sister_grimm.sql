CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE SCHEMA "crm";
--> statement-breakpoint
CREATE SCHEMA "iam";
--> statement-breakpoint
CREATE SCHEMA "tenancy";
--> statement-breakpoint
CREATE TABLE "crm"."customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_code" text NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"address" text,
	"area_id" uuid,
	"location_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"outstanding_balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "customers_customer_code_unique" UNIQUE("customer_code")
);
--> statement-breakpoint
CREATE TABLE "auth"."devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_device_id" text NOT NULL,
	"platform" text NOT NULL,
	"os_version" text,
	"model" text,
	"app_version" text,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_client_device_id_unique" UNIQUE("client_device_id")
);
--> statement-breakpoint
CREATE TABLE "tenancy"."membership_areas" (
	"membership_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	CONSTRAINT "membership_areas_uq" UNIQUE("membership_id","area_id")
);
--> statement-breakpoint
CREATE TABLE "tenancy"."membership_locations" (
	"membership_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "membership_locations_uq" UNIQUE("membership_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "tenancy"."tenant_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"team_id" uuid,
	"permission_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_memberships_user_tenant_uq" UNIQUE("user_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "iam"."role_permissions" (
	"role_id" text NOT NULL,
	"permission_key" text NOT NULL,
	"scope" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "iam"."roles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"prev_token_hash" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "tenancy"."tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"customer_seq" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenants_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "auth"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"phone" text,
	"password_hash" text,
	"google_sub" text,
	"name" text,
	"photo_url" text,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp with time zone,
	"credentials_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "users_identifier_present" CHECK ("auth"."users"."email" IS NOT NULL OR "auth"."users"."phone" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."membership_areas" ADD CONSTRAINT "membership_areas_membership_id_tenant_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "tenancy"."tenant_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."membership_locations" ADD CONSTRAINT "membership_locations_membership_id_tenant_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "tenancy"."tenant_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."tenant_memberships" ADD CONSTRAINT "tenant_memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "iam"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "iam"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "auth"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_tenant_created_idx" ON "crm"."customers" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customers_tenant_status_idx" ON "crm"."customers" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "customers_tenant_phone_idx" ON "crm"."customers" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "customers_area_idx" ON "crm"."customers" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "customers_location_idx" ON "crm"."customers" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "devices_blocked_at_idx" ON "auth"."devices" USING btree ("blocked_at");--> statement-breakpoint
CREATE INDEX "tenant_memberships_tenant_idx" ON "tenancy"."tenant_memberships" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_memberships_user_idx" ON "tenancy"."tenant_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "roles_tenant_id_idx" ON "iam"."roles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "auth"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_device_idx" ON "auth"."sessions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "sessions_revoked_at_idx" ON "auth"."sessions" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenancy"."tenants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_disabled_at_idx" ON "auth"."users" USING btree ("disabled_at");
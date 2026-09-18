CREATE SCHEMA IF NOT EXISTS "analytics";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "audit";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "auth";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "billing";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "crm";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "geo";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "iam";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "inventory";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "media";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "notify";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "remotes";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "tenancy";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth.normalise_email(address text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$ SELECT nullif(lower(btrim(address)), '') $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION crm.normalize_phone(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT regexp_replace(value, '[^0-9]', '', 'g')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION iam.scope_rank(scope text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE scope
    WHEN 'OWN'      THEN 1
    WHEN 'ASSIGNED' THEN 2
    WHEN 'TEAM'     THEN 3
    WHEN 'LOCATION' THEN 4
    WHEN 'ALL'      THEN 5
    ELSE 0
  END
$$;
--> statement-breakpoint
CREATE TABLE "audit"."audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"actor_id" uuid,
	"actor_session_id" uuid,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"old_values" jsonb,
	"new_values" jsonb,
	"changes" jsonb,
	"request_id" text,
	"correlation_id" text,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_device_id" text NOT NULL,
	"platform" text NOT NULL,
	"os_version" text,
	"manufacturer" text,
	"model" text,
	"app_version" text,
	"ram_mb" integer,
	"screen_resolution" text,
	"push_token" text,
	"push_token_updated_at" timestamp with time zone,
	"last_tenant_id" uuid,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_client_device_id_unique" UNIQUE("client_device_id")
);
--> statement-breakpoint
CREATE TABLE "auth"."otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"purpose" text DEFAULT 'login' NOT NULL,
	"channel" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "auth"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_code" text,
	"email" text,
	"phone" varchar(10),
	"password_hash" text,
	"google_sub" text,
	"name" text,
	"photo_url" text,
	"disabled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"credentials_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_customer_code_unique" UNIQUE("customer_code"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "users_identifier_present" CHECK ("auth"."users"."email" IS NOT NULL OR "auth"."users"."phone" IS NOT NULL),
	CONSTRAINT "users_phone_ten_digits" CHECK ("auth"."users"."phone" IS NULL OR "auth"."users"."phone" ~ '^[0-9]{10}$'),
	CONSTRAINT "users_email_normalised" CHECK ("auth"."users"."email" IS NULL OR "auth"."users"."email" = auth.normalise_email("auth"."users"."email"))
);
--> statement-breakpoint
CREATE TABLE "billing"."collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"subscription_id" uuid,
	"customer_equipment_id" uuid,
	"collected_by" uuid NOT NULL,
	"outcome" text NOT NULL,
	"method" text,
	"due_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"dues_paid" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_collected" numeric(12, 2) GENERATED ALWAYS AS (dues_paid) STORED NOT NULL,
	"balance_after" numeric(12, 2) DEFAULT '0' NOT NULL,
	"transaction_id" uuid,
	"reverses_id" uuid,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"gps_accuracy_m" numeric(8, 2),
	"reason" text,
	"notes" text,
	"reference" text NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_tenant_reference_uq" UNIQUE("tenant_id","reference"),
	CONSTRAINT "collections_reverses_uq" UNIQUE("reverses_id"),
	CONSTRAINT "collections_outcome_check" CHECK ("billing"."collections"."outcome" IN ('full', 'partial', 'none', 'refund', 'others')),
	CONSTRAINT "collections_method_check" CHECK ("billing"."collections"."method" IS NULL OR "billing"."collections"."method" IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque')),
	CONSTRAINT "collections_target_check" CHECK ("billing"."collections"."subscription_id" IS NOT NULL OR "billing"."collections"."customer_equipment_id" IS NOT NULL),
	CONSTRAINT "collections_no_payment_is_empty" CHECK ("billing"."collections"."outcome" <> 'none' OR "billing"."collections"."dues_paid" = 0),
	CONSTRAINT "collections_takings_not_negative" CHECK ("billing"."collections"."outcome" = 'refund' OR "billing"."collections"."dues_paid" >= 0),
	CONSTRAINT "collections_refund_gives_back" CHECK ("billing"."collections"."outcome" <> 'refund' OR "billing"."collections"."dues_paid" <= 0),
	CONSTRAINT "collections_point_is_whole" CHECK (("billing"."collections"."latitude" IS NULL) = ("billing"."collections"."longitude" IS NULL)),
	CONSTRAINT "collections_point_is_on_earth" CHECK ("billing"."collections"."latitude" IS NULL OR ("billing"."collections"."latitude" BETWEEN -90 AND 90 AND "billing"."collections"."longitude" BETWEEN -180 AND 180))
);
--> statement-breakpoint
CREATE TABLE "crm"."account_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
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
	"collected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_provider_id" uuid NOT NULL,
	"channel_number" integer NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"genre" text DEFAULT 'General' NOT NULL,
	"languages" text[] DEFAULT ARRAY['Telugu']::text[] NOT NULL,
	"resolution" text DEFAULT 'SD' NOT NULL,
	"is_fta" boolean DEFAULT false NOT NULL,
	"broadcaster" text,
	"price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"logo_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_provider_number_unq" UNIQUE("service_provider_id","channel_number"),
	CONSTRAINT "channels_provider_slug_unq" UNIQUE("service_provider_id","slug")
);
--> statement-breakpoint
CREATE TABLE "crm"."customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_code" text,
	"user_id" uuid,
	"name" text,
	"phone" varchar(10),
	"alternate_phone" varchar(10),
	"whatsapp_number" varchar(10),
	"national_id_type" text,
	"national_id_number" text,
	"address" text,
	"status" text DEFAULT 'active' NOT NULL,
	"outstanding_balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"metadata" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm"."package_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"is_mandatory" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_channels_pkg_channel_unq" UNIQUE("package_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_provider_id" uuid NOT NULL,
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
	"deleted_at" timestamp with time zone,
	CONSTRAINT "packages_provider_slug_uq" UNIQUE("service_provider_id","slug")
);
--> statement-breakpoint
CREATE TABLE "crm"."service_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"service_provider_id" uuid,
	"package_id" uuid,
	"location_id" uuid NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_coverage_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","service_id","service_provider_id","package_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."service_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"code" text,
	"description" text,
	"contact" jsonb,
	"metadata" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "service_providers_service_slug_uq" UNIQUE("tenant_id","service_id","slug")
);
--> statement-breakpoint
CREATE TABLE "crm"."services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"icon" text,
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
	"service_provider_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"service_account_number" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"start_date" timestamp with time zone DEFAULT now() NOT NULL,
	"end_date" timestamp with time zone,
	"billing_cycle" text DEFAULT 'monthly' NOT NULL,
	"price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"outstanding_balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"installation_location_id" uuid NOT NULL,
	"installation_address" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
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
CREATE TABLE "iam"."role_permissions" (
	"role_id" text NOT NULL,
	"permission_key" text NOT NULL,
	"scope" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key"),
	CONSTRAINT "role_permissions_known_scope" CHECK ("scope" IN ('OWN', 'ASSIGNED', 'TEAM', 'LOCATION', 'ALL'))
);
--> statement-breakpoint
CREATE TABLE "iam"."roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_known_id" CHECK ("iam"."roles"."id" IN ('admin', 'staff', 'customer'))
);
--> statement-breakpoint
CREATE TABLE "inventory"."approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"request_type" text NOT NULL,
	"target_item_id" uuid,
	"proposed_data" jsonb,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory"."customer_equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"subscription_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"ownership_type" text DEFAULT 'tenant_provided' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid,
	"returned_at" timestamp with time zone,
	"return_condition" text,
	"collected_by" uuid,
	"returned_to_location_id" uuid,
	"return_remarks" text,
	"replaced_by_equipment_id" uuid,
	"deposit_refund_status" text DEFAULT 'not_applicable' NOT NULL,
	"deposit_deduction_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory"."equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"catalog_id" uuid,
	"location_id" uuid,
	"staff_id" uuid,
	"serial_number" text,
	"vc_number" text,
	"mac_address" text,
	"barcode" text,
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
CREATE TABLE "inventory"."item_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_type_id" uuid,
	"name" text NOT NULL,
	"code" text,
	"brand" text,
	"model" text,
	"icon" text,
	"photo_url" text,
	"photo_file_id" uuid,
	"description" text,
	"is_bundle" boolean DEFAULT false NOT NULL,
	"default_ownership" text DEFAULT 'tenant_provided' NOT NULL,
	"default_sale_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"default_deposit_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"default_rental_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"is_returnable" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
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
CREATE TABLE "media"."files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text,
	"bucket" text,
	"public_url" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size_bytes" bigint,
	"checksum" text,
	"checksum_algorithm" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "files_source_check" CHECK ("media"."files"."storage_key" IS NOT NULL OR "media"."files"."public_url" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "media"."user_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"uploaded_by" uuid,
	"file_id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"kind" text DEFAULT 'upload' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notify"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"channel" text NOT NULL,
	"provider" text NOT NULL,
	"destination" text NOT NULL,
	"sender" text,
	"subject" text,
	"content" text NOT NULL,
	"template_id" text,
	"template_params" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"provider_response" jsonb,
	"cost" numeric(10, 4),
	"error" text,
	"error_code" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notify"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"channel" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"delivery" text DEFAULT 'notification' NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"data" jsonb,
	"image_url" text,
	"destination" text,
	"file_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remotes"."remote_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remote_id" uuid,
	"button_name" text NOT NULL,
	"button_key" text NOT NULL,
	"protocol" text NOT NULL,
	"address" text NOT NULL,
	"command" text NOT NULL,
	"command_number" integer NOT NULL,
	"raw_data" text NOT NULL,
	"bits" integer NOT NULL,
	"bit_order" text NOT NULL,
	"repeat" boolean DEFAULT false NOT NULL,
	"raw_timings" jsonb NOT NULL,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_captures_remote_btn_uq" UNIQUE("remote_id","button_name")
);
--> statement-breakpoint
CREATE TABLE "remotes"."remotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"device_type" text NOT NULL,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"source" text DEFAULT 'library' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"notes" text,
	"buttons" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remotes_tenant_model_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","device_type","brand","model")
);
--> statement-breakpoint
CREATE TABLE "tenancy"."membership_locations" (
	"membership_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "membership_locations_uq" UNIQUE("membership_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "tenancy"."team_locations" (
	"team_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "team_locations_uq" UNIQUE("team_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "tenancy"."team_member_locations" (
	"membership_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "team_member_locations_uq" UNIQUE("membership_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "tenancy"."teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"leader_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "teams_tenant_slug_uq" UNIQUE("tenant_id","slug"),
	CONSTRAINT "teams_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "teams_leader_membership_uq" UNIQUE("leader_membership_id")
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
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenant_memberships_user_tenant_uq" UNIQUE("user_id","tenant_id")
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
ALTER TABLE "auth"."devices" ADD CONSTRAINT "devices_last_tenant_id_tenants_id_fk" FOREIGN KEY ("last_tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "auth"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."collections" ADD CONSTRAINT "collections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."collections" ADD CONSTRAINT "collections_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "crm"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."collections" ADD CONSTRAINT "collections_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "crm"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."collections" ADD CONSTRAINT "collections_customer_equipment_id_customer_equipment_id_fk" FOREIGN KEY ("customer_equipment_id") REFERENCES "inventory"."customer_equipment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."collections" ADD CONSTRAINT "collections_collected_by_users_id_fk" FOREIGN KEY ("collected_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."collections" ADD CONSTRAINT "collections_transaction_id_account_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "crm"."account_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."collections" ADD CONSTRAINT "collections_reverses_id_collections_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "billing"."collections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."account_transactions" ADD CONSTRAINT "account_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."account_transactions" ADD CONSTRAINT "account_transactions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "crm"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."account_transactions" ADD CONSTRAINT "account_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "crm"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."account_transactions" ADD CONSTRAINT "account_transactions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "crm"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."account_transactions" ADD CONSTRAINT "account_transactions_collector_membership_fk" FOREIGN KEY ("tenant_id","collected_by") REFERENCES "tenancy"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."channels" ADD CONSTRAINT "channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."channels" ADD CONSTRAINT "channels_service_provider_id_service_providers_id_fk" FOREIGN KEY ("service_provider_id") REFERENCES "crm"."service_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."package_channels" ADD CONSTRAINT "package_channels_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "crm"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."package_channels" ADD CONSTRAINT "package_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "crm"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."packages" ADD CONSTRAINT "packages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."packages" ADD CONSTRAINT "packages_service_provider_id_service_providers_id_fk" FOREIGN KEY ("service_provider_id") REFERENCES "crm"."service_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "crm"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_service_provider_id_service_providers_id_fk" FOREIGN KEY ("service_provider_id") REFERENCES "crm"."service_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "crm"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_providers" ADD CONSTRAINT "service_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_providers" ADD CONSTRAINT "service_providers_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "crm"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "crm"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_service_provider_id_service_providers_id_fk" FOREIGN KEY ("service_provider_id") REFERENCES "crm"."service_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "crm"."packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_installation_location_id_locations_id_fk" FOREIGN KEY ("installation_location_id") REFERENCES "geo"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_aliases" ADD CONSTRAINT "location_aliases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_aliases" ADD CONSTRAINT "location_aliases_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_categories" ADD CONSTRAINT "location_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_schema_levels" ADD CONSTRAINT "location_schema_levels_schema_id_location_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "geo"."location_schemas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_schema_levels" ADD CONSTRAINT "location_schema_levels_category_id_location_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "geo"."location_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."location_schemas" ADD CONSTRAINT "location_schemas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."locations" ADD CONSTRAINT "locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."locations" ADD CONSTRAINT "locations_schema_id_location_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "geo"."location_schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."locations" ADD CONSTRAINT "locations_category_id_location_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "geo"."location_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."locations" ADD CONSTRAINT "locations_parent_id_locations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "geo"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo"."locations" ADD CONSTRAINT "locations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "iam"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."approval_requests" ADD CONSTRAINT "approval_requests_target_item_id_item_catalog_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "inventory"."item_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."approval_requests" ADD CONSTRAINT "approval_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "inventory"."equipment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "crm"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "crm"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_collected_by_users_id_fk" FOREIGN KEY ("collected_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_returned_to_location_id_locations_id_fk" FOREIGN KEY ("returned_to_location_id") REFERENCES "geo"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."customer_equipment" ADD CONSTRAINT "customer_equipment_replaced_by_equipment_id_equipment_id_fk" FOREIGN KEY ("replaced_by_equipment_id") REFERENCES "inventory"."equipment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."equipment" ADD CONSTRAINT "equipment_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."equipment" ADD CONSTRAINT "equipment_catalog_id_item_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "inventory"."item_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."equipment" ADD CONSTRAINT "equipment_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."equipment" ADD CONSTRAINT "equipment_staff_id_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."item_catalog" ADD CONSTRAINT "item_catalog_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."item_catalog" ADD CONSTRAINT "item_catalog_item_type_id_item_types_id_fk" FOREIGN KEY ("item_type_id") REFERENCES "inventory"."item_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."item_catalog" ADD CONSTRAINT "item_catalog_photo_file_id_files_id_fk" FOREIGN KEY ("photo_file_id") REFERENCES "media"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."item_types" ADD CONSTRAINT "item_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "inventory"."equipment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "geo"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "geo"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_from_staff_id_users_id_fk" FOREIGN KEY ("from_staff_id") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_to_staff_id_users_id_fk" FOREIGN KEY ("to_staff_id") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."user_files" ADD CONSTRAINT "user_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."user_files" ADD CONSTRAINT "user_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."user_files" ADD CONSTRAINT "user_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "media"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify"."messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify"."notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify"."notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify"."notifications" ADD CONSTRAINT "notifications_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "media"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remotes"."remote_captures" ADD CONSTRAINT "remote_captures_remote_id_remotes_id_fk" FOREIGN KEY ("remote_id") REFERENCES "remotes"."remotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remotes"."remotes" ADD CONSTRAINT "remotes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."membership_locations" ADD CONSTRAINT "membership_locations_membership_id_tenant_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "tenancy"."tenant_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."membership_locations" ADD CONSTRAINT "membership_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."team_locations" ADD CONSTRAINT "team_locations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "tenancy"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."team_locations" ADD CONSTRAINT "team_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."team_member_locations" ADD CONSTRAINT "team_member_locations_membership_id_tenant_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "tenancy"."tenant_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."team_member_locations" ADD CONSTRAINT "team_member_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."teams" ADD CONSTRAINT "teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."teams" ADD CONSTRAINT "teams_leader_membership_id_tenant_memberships_id_fk" FOREIGN KEY ("leader_membership_id") REFERENCES "tenancy"."tenant_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."tenant_memberships" ADD CONSTRAINT "tenant_memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "iam"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."tenant_memberships" ADD CONSTRAINT "tenant_memberships_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "tenancy"."teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit"."audit_logs" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_entity_created_idx" ON "audit"."audit_logs" USING btree ("tenant_id","entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_actor_created_idx" ON "audit"."audit_logs" USING btree ("tenant_id","actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "devices_blocked_at_idx" ON "auth"."devices" USING btree ("blocked_at");--> statement-breakpoint
CREATE INDEX "devices_push_token_idx" ON "auth"."devices" USING btree ("last_tenant_id") WHERE "auth"."devices"."push_token" IS NOT NULL AND "auth"."devices"."blocked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "otp_codes_identifier_idx" ON "auth"."otp_codes" USING btree ("identifier","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "otp_codes_expires_at_idx" ON "auth"."otp_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "otp_codes_one_active_idx" ON "auth"."otp_codes" USING btree ("identifier","purpose") WHERE "auth"."otp_codes"."consumed_at" IS NULL AND "auth"."otp_codes"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "auth"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_device_idx" ON "auth"."sessions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "sessions_revoked_at_idx" ON "auth"."sessions" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "sessions_active_prev_token_idx" ON "auth"."sessions" USING btree ("prev_token_hash") WHERE "auth"."sessions"."revoked_at" IS NULL AND "auth"."sessions"."prev_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_disabled_at_idx" ON "auth"."users" USING btree ("disabled_at");--> statement-breakpoint
CREATE INDEX "users_deleted_at_idx" ON "auth"."users" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "users_name_trgm_idx" ON "auth"."users" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_phone_trgm_idx" ON "auth"."users" USING gin ("phone" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "collections_tenant_collected_idx" ON "billing"."collections" USING btree ("tenant_id","collected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collections_tenant_collector_idx" ON "billing"."collections" USING btree ("tenant_id","collected_by","collected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collections_tenant_customer_idx" ON "billing"."collections" USING btree ("tenant_id","customer_id","collected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collections_tenant_customer_equipment_idx" ON "billing"."collections" USING btree ("tenant_id","customer_equipment_id");--> statement-breakpoint
CREATE INDEX "collections_point_gix" ON "billing"."collections" USING gist ((ST_SetSRID(ST_MakePoint("longitude"::double precision, "latitude"::double precision), 4326)::geography)) WHERE "billing"."collections"."latitude" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "account_tx_tenant_service_idx" ON "crm"."account_transactions" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "account_tx_tenant_acc_idx" ON "crm"."account_transactions" USING btree ("tenant_id","service_account_number");--> statement-breakpoint
CREATE INDEX "account_tx_tenant_cust_idx" ON "crm"."account_transactions" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "account_tx_tenant_tx_idx" ON "crm"."account_transactions" USING btree ("tenant_id","transaction_no");--> statement-breakpoint
CREATE INDEX "account_tx_tenant_date_idx" ON "crm"."account_transactions" USING btree ("tenant_id","transaction_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "account_tx_tenant_collector_date_idx" ON "crm"."account_transactions" USING btree ("tenant_id","collected_by","transaction_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "channels_provider_idx" ON "crm"."channels" USING btree ("service_provider_id");--> statement-breakpoint
CREATE INDEX "channels_tenant_genre_idx" ON "crm"."channels" USING btree ("tenant_id","genre");--> statement-breakpoint
CREATE INDEX "channels_languages_idx" ON "crm"."channels" USING gin ("languages");--> statement-breakpoint
CREATE INDEX "channels_tenant_status_idx" ON "crm"."channels" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "customers_tenant_created_idx" ON "crm"."customers" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customers_name_trgm_idx" ON "crm"."customers" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_phone_trgm_idx" ON "crm"."customers" USING gin ("phone" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_code_trgm_idx" ON "crm"."customers" USING gin ("customer_code" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_extra_search_trgm_idx" ON "crm"."customers" USING gin ((
    coalesce("alternate_phone", '') || ' ' ||
    coalesce("whatsapp_number", '') || ' ' ||
    coalesce("address", '')
  ) gin_trgm_ops) WHERE "crm"."customers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "customers_tenant_status_idx" ON "crm"."customers" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "customers_user_idx" ON "crm"."customers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "package_channels_package_idx" ON "crm"."package_channels" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "package_channels_channel_idx" ON "crm"."package_channels" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "packages_tenant_provider_idx" ON "crm"."packages" USING btree ("tenant_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "packages_tenant_status_idx" ON "crm"."packages" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "service_coverage_tenant_location_idx" ON "crm"."service_coverage" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "service_coverage_tenant_provider_idx" ON "crm"."service_coverage" USING btree ("tenant_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "service_coverage_tenant_package_idx" ON "crm"."service_coverage" USING btree ("tenant_id","package_id");--> statement-breakpoint
CREATE INDEX "service_coverage_tenant_avail_idx" ON "crm"."service_coverage" USING btree ("tenant_id","is_available");--> statement-breakpoint
CREATE INDEX "service_providers_tenant_service_idx" ON "crm"."service_providers" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "service_providers_tenant_status_idx" ON "crm"."service_providers" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "services_tenant_status_idx" ON "crm"."services" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "services_tenant_slug_idx" ON "crm"."services" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_customer_idx" ON "crm"."subscriptions" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_provider_idx" ON "crm"."subscriptions" USING btree ("tenant_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_package_idx" ON "crm"."subscriptions" USING btree ("tenant_id","package_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_status_idx" ON "crm"."subscriptions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_account_idx" ON "crm"."subscriptions" USING btree ("tenant_id","service_account_number");--> statement-breakpoint
CREATE INDEX "subscriptions_search_trgm_idx" ON "crm"."subscriptions" USING gin ((
    "service_account_number" || ' ' || coalesce("installation_address", '')
  ) gin_trgm_ops) WHERE "crm"."subscriptions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "subscriptions_installation_location_idx" ON "crm"."subscriptions" USING btree ("installation_location_id");--> statement-breakpoint
CREATE INDEX "location_aliases_tenant_idx" ON "geo"."location_aliases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "locations_tenant_parent_idx" ON "geo"."locations" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE INDEX "locations_tenant_category_idx" ON "geo"."locations" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "locations_tenant_schema_idx" ON "geo"."locations" USING btree ("tenant_id","schema_id");--> statement-breakpoint
CREATE INDEX "locations_tenant_created_idx" ON "geo"."locations" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "locations_code_trgm_idx" ON "geo"."locations" USING gin ("code" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "approval_requests_tenant_status_idx" ON "inventory"."approval_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "approval_requests_tenant_req_by_idx" ON "inventory"."approval_requests" USING btree ("tenant_id","requested_by");--> statement-breakpoint
CREATE INDEX "approval_requests_tenant_created_idx" ON "inventory"."approval_requests" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "customer_equipment_active_equipment_unique_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","equipment_id") WHERE "inventory"."customer_equipment"."status" IN ('active', 'standby');--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_sub_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","subscription_id");--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_cust_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_cust_status_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","customer_id","status");--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_eq_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","equipment_id");--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_eq_assigned_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","equipment_id","assigned_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customer_equipment_tenant_status_idx" ON "inventory"."customer_equipment" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "equipment_tenant_serial_idx" ON "inventory"."equipment" USING btree ("tenant_id","serial_number");--> statement-breakpoint
CREATE INDEX "equipment_tenant_vc_idx" ON "inventory"."equipment" USING btree ("tenant_id","vc_number");--> statement-breakpoint
CREATE INDEX "equipment_tenant_mac_idx" ON "inventory"."equipment" USING btree ("tenant_id","mac_address");--> statement-breakpoint
CREATE INDEX "equipment_tenant_inv_status_idx" ON "inventory"."equipment" USING btree ("tenant_id","inventory_status");--> statement-breakpoint
CREATE INDEX "equipment_tenant_location_idx" ON "inventory"."equipment" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "equipment_tenant_staff_idx" ON "inventory"."equipment" USING btree ("tenant_id","staff_id");--> statement-breakpoint
CREATE INDEX "equipment_tenant_catalog_idx" ON "inventory"."equipment" USING btree ("tenant_id","catalog_id");--> statement-breakpoint
CREATE INDEX "equipment_search_trgm_idx" ON "inventory"."equipment" USING gin ((
    coalesce("serial_number", '') || ' ' || coalesce("vc_number", '') || ' ' ||
    coalesce("mac_address", '') || ' ' || coalesce("barcode", '')
  ) gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "item_catalog_tenant_code_uq" ON "inventory"."item_catalog" USING btree ("tenant_id",coalesce("code", '')) WHERE "inventory"."item_catalog"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "item_catalog_tenant_idx" ON "inventory"."item_catalog" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "item_catalog_tenant_type_idx" ON "inventory"."item_catalog" USING btree ("tenant_id","item_type_id");--> statement-breakpoint
CREATE INDEX "item_catalog_tenant_photo_file_idx" ON "inventory"."item_catalog" USING btree ("tenant_id","photo_file_id");--> statement-breakpoint
CREATE INDEX "item_catalog_search_trgm_idx" ON "inventory"."item_catalog" USING gin ((
    coalesce("name", '') || ' ' || coalesce("code", '') || ' ' ||
    coalesce("brand", '') || ' ' || coalesce("model", '')
  ) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "item_types_tenant_idx" ON "inventory"."item_types" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_eq_idx" ON "inventory"."stock_movements" USING btree ("tenant_id","equipment_id");--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_created_idx" ON "inventory"."stock_movements" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_type_idx" ON "inventory"."stock_movements" USING btree ("tenant_id","movement_type");--> statement-breakpoint
CREATE UNIQUE INDEX "files_storage_key_unq" ON "media"."files" USING btree ("storage_key") WHERE "media"."files"."storage_key" IS NOT NULL AND "media"."files"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "files_checksum_unq" ON "media"."files" USING btree ("checksum") WHERE "media"."files"."checksum" IS NOT NULL AND "media"."files"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "files_status_idx" ON "media"."files" USING btree ("status");--> statement-breakpoint
CREATE INDEX "files_expires_at_idx" ON "media"."files" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "files_public_url_idx" ON "media"."files" USING btree ("public_url") WHERE "media"."files"."public_url" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_files_tenant_created_idx" ON "media"."user_files" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_files_file_idx" ON "media"."user_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "user_files_uploaded_by_idx" ON "media"."user_files" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "messages_tenant_created_idx" ON "notify"."messages" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_provider_msg_id_idx" ON "notify"."messages" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_status_idx" ON "notify"."messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "messages_destination_idx" ON "notify"."messages" USING btree ("destination");--> statement-breakpoint
CREATE INDEX "messages_channel_idx" ON "notify"."messages" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notify"."notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_tenant_created_idx" ON "notify"."notifications" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notify"."notifications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notifications_pending_in_app_idx" ON "notify"."notifications" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE "notify"."notifications"."delivery" = 'in_app' AND "notify"."notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "remote_captures_remote_idx" ON "remotes"."remote_captures" USING btree ("remote_id");--> statement-breakpoint
CREATE INDEX "remote_captures_btn_key_idx" ON "remotes"."remote_captures" USING btree ("button_key");--> statement-breakpoint
CREATE INDEX "remotes_device_type_idx" ON "remotes"."remotes" USING btree ("device_type");--> statement-breakpoint
CREATE INDEX "remotes_tenant_idx" ON "remotes"."remotes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "team_locations_location_idx" ON "tenancy"."team_locations" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "team_member_locations_location_idx" ON "tenancy"."team_member_locations" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "teams_tenant_status_idx" ON "tenancy"."teams" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "tenant_memberships_tenant_idx" ON "tenancy"."tenant_memberships" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_memberships_team_idx" ON "tenancy"."tenant_memberships" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "tenant_memberships_user_idx" ON "tenancy"."tenant_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenancy"."tenants" USING btree ("status");--> statement-breakpoint
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
$$ LANGUAGE plpgsql VOLATILE;--> statement-breakpoint
CREATE OR REPLACE FUNCTION geo.location_descendants(root uuid)
RETURNS TABLE (id uuid, depth integer)
LANGUAGE sql
STABLE
PARALLEL SAFE
ROWS 100
AS $$
  WITH RECURSIVE tree AS (
    SELECT l.id, 0 AS depth
    FROM geo.locations l
    WHERE l.id = root

    UNION ALL

    SELECT child.id, tree.depth + 1
    FROM geo.locations child
    JOIN tree ON child.parent_id = tree.id
  ) CYCLE id SET is_cycle USING visited
  SELECT tree.id, tree.depth FROM tree WHERE NOT is_cycle
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION geo.location_ancestors(node uuid)
RETURNS TABLE (id uuid, depth integer)
LANGUAGE sql
STABLE
PARALLEL SAFE
ROWS 8
AS $$
  WITH RECURSIVE chain AS (
    SELECT l.id, l.parent_id, 0 AS depth
    FROM geo.locations l
    WHERE l.id = node

    UNION ALL

    SELECT parent.id, parent.parent_id, chain.depth + 1
    FROM geo.locations parent
    JOIN chain ON chain.parent_id = parent.id
  ) CYCLE id SET is_cycle USING visited
  SELECT chain.id, chain.depth FROM chain WHERE NOT is_cycle
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION crm.coverage_allows(
  p_tenant   uuid,
  p_service  uuid,
  p_provider uuid,
  p_package  uuid,
  p_location uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH chain AS (
    SELECT id, depth FROM geo.location_ancestors(p_location)
  ),
  scoped AS (
    SELECT c.service_provider_id, c.package_id, c.location_id, c.is_available
    FROM crm.service_coverage c
    WHERE c.tenant_id = p_tenant
      AND c.service_id = p_service
      AND (c.service_provider_id IS NULL OR c.service_provider_id = p_provider)
      AND (c.package_id IS NULL OR c.package_id = p_package)
  ),
  levels AS (
    SELECT
      bool_or(s.is_available) AS has_allowlist,
      (
        SELECT n.is_available
        FROM scoped n
        JOIN chain ON chain.id = n.location_id
        WHERE n.service_provider_id IS NOT DISTINCT FROM s.service_provider_id
          AND n.package_id IS NOT DISTINCT FROM s.package_id
        ORDER BY chain.depth
        LIMIT 1
      ) AS nearest
    FROM scoped s
    GROUP BY s.service_provider_id, s.package_id
  )
  SELECT bool_and(coalesce(nearest, NOT has_allowlist)) IS NOT FALSE FROM levels
$$;--> statement-breakpoint--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_tenant_normalized_phone_idx
  ON crm.customers (tenant_id, crm.normalize_phone(phone));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS location_aliases_trgm_idx
  ON geo.location_aliases USING gin (alias gin_trgm_ops);--> statement-breakpoint
ALTER TABLE geo.location_schema_levels
  ALTER CONSTRAINT location_schema_levels_category_id_location_categories_id_fk DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE geo.locations
  ALTER CONSTRAINT locations_category_id_location_categories_id_fk DEFERRABLE INITIALLY DEFERRED,
  ALTER CONSTRAINT locations_schema_id_location_schemas_id_fk DEFERRABLE INITIALLY DEFERRED,
  ALTER CONSTRAINT locations_parent_id_locations_id_fk DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE OR REPLACE VIEW geo.location_paths AS
WITH RECURSIVE walk AS (
  SELECT
    l.id,
    l.tenant_id,
    l.id                       AS root_id,
    0                          AS depth,
    ARRAY[l.id]                AS path_ids,
    l.name                     AS path
  FROM geo.locations l
  WHERE l.parent_id IS NULL

  UNION ALL

  SELECT
    child.id,
    child.tenant_id,
    walk.root_id,
    walk.depth + 1,
    walk.path_ids || child.id,
    walk.path || ' / ' || child.name
  FROM geo.locations child
  JOIN walk ON child.parent_id = walk.id
) CYCLE id SET is_cycle USING visited
SELECT id, tenant_id, root_id, depth, path_ids, path
FROM walk
WHERE NOT is_cycle;--> statement-breakpoint
CREATE OR REPLACE VIEW analytics.tenant_customer_stats AS
SELECT
  t.id                                                                      AS tenant_id,
  t.code                                                                    AS tenant_code,
  count(c.id)::int                                                          AS total_customers,
  count(c.id) FILTER (WHERE c.status = 'active')::int                       AS active_customers,
  count(c.id) FILTER (WHERE c.status = 'inactive')::int                     AS inactive_customers,
  count(c.id) FILTER (WHERE c.status = 'pending')::int                      AS pending_customers,
  count(c.id) FILTER (WHERE c.created_at >= date_trunc('month', now()))::int AS added_this_month,
  coalesce(sum(c.outstanding_balance), 0)::numeric(14, 2)                   AS outstanding_total
FROM tenancy.tenants t
LEFT JOIN crm.customers c
  ON c.tenant_id = t.id AND c.deleted_at IS NULL
WHERE t.deleted_at IS NULL
GROUP BY t.id, t.code;--> statement-breakpoint
CREATE OR REPLACE VIEW notify.user_unread_counts AS
SELECT
  n.tenant_id,
  n.user_id,
  count(*)::int  AS unread_count,
  max(n.created_at) AS latest_at
FROM notify.notifications n
WHERE n.channel = 'in_app'
  AND n.read_at IS NULL
  AND n.tenant_id IS NOT NULL
  AND n.user_id IS NOT NULL
GROUP BY n.tenant_id, n.user_id;--> statement-breakpoint
CREATE OR REPLACE VIEW analytics.messaging_health AS
SELECT
  n.channel,
  count(*) FILTER (WHERE n.status = 'sent')::int   AS sent,
  count(*) FILTER (WHERE n.status = 'failed')::int AS failed,
  count(*) FILTER (WHERE n.status = 'queued')::int AS queued,
  (count(*) FILTER (WHERE n.status = 'failed') * 10 <= count(*)) AS healthy
FROM notify.notifications n
WHERE n.created_at >= now() - interval '24 hours'
GROUP BY n.channel;
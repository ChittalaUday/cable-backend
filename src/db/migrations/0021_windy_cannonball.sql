CREATE TABLE "crm"."service_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"service_provider_id" uuid,
	"location_id" uuid NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_coverage_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","service_id","service_provider_id","location_id")
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
ALTER TABLE "crm"."channels" ADD COLUMN "service_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."packages" ADD COLUMN "service_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD COLUMN "service_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "crm"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_service_provider_id_service_providers_id_fk" FOREIGN KEY ("service_provider_id") REFERENCES "crm"."service_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_providers" ADD CONSTRAINT "service_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."service_providers" ADD CONSTRAINT "service_providers_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "crm"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_coverage_tenant_location_idx" ON "crm"."service_coverage" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "service_coverage_tenant_provider_idx" ON "crm"."service_coverage" USING btree ("tenant_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "service_providers_tenant_service_idx" ON "crm"."service_providers" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "service_providers_tenant_status_idx" ON "crm"."service_providers" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "crm"."channels" ADD CONSTRAINT "channels_service_provider_id_service_providers_id_fk" FOREIGN KEY ("service_provider_id") REFERENCES "crm"."service_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."packages" ADD CONSTRAINT "packages_service_provider_id_service_providers_id_fk" FOREIGN KEY ("service_provider_id") REFERENCES "crm"."service_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_service_provider_id_service_providers_id_fk" FOREIGN KEY ("service_provider_id") REFERENCES "crm"."service_providers"("id") ON DELETE restrict ON UPDATE no action;
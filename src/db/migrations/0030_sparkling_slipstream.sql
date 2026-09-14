CREATE TABLE "tenancy"."teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "teams_tenant_slug_uq" UNIQUE("tenant_id","slug"),
	CONSTRAINT "teams_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "iam"."role_permissions" DROP CONSTRAINT "role_permissions_known_scope";--> statement-breakpoint
ALTER TABLE "tenancy"."teams" ADD CONSTRAINT "teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teams_tenant_status_idx" ON "tenancy"."teams" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "tenancy"."tenant_memberships" ADD CONSTRAINT "tenant_memberships_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "tenancy"."teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_memberships_team_idx" ON "tenancy"."tenant_memberships" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_known_scope" CHECK ("scope" IN ('OWN', 'ASSIGNED', 'TEAM', 'LOCATION', 'ALL'));
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
CREATE TABLE "inventory"."remotes" (
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
ALTER TABLE "inventory"."approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."approval_requests" ADD CONSTRAINT "approval_requests_target_item_id_item_catalog_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "inventory"."item_catalog"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."approval_requests" ADD CONSTRAINT "approval_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."remotes" ADD CONSTRAINT "remotes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_tenant_status_idx" ON "inventory"."approval_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "approval_requests_tenant_req_by_idx" ON "inventory"."approval_requests" USING btree ("tenant_id","requested_by");--> statement-breakpoint
CREATE INDEX "approval_requests_tenant_created_idx" ON "inventory"."approval_requests" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "remotes_device_type_idx" ON "inventory"."remotes" USING btree ("device_type");--> statement-breakpoint
CREATE INDEX "remotes_tenant_idx" ON "inventory"."remotes" USING btree ("tenant_id");
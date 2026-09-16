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
ALTER TABLE "remotes"."remotes" ADD CONSTRAINT "remotes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remotes_device_type_idx" ON "remotes"."remotes" USING btree ("device_type");--> statement-breakpoint
CREATE INDEX "remotes_tenant_idx" ON "remotes"."remotes" USING btree ("tenant_id");
CREATE SCHEMA "media";
--> statement-breakpoint
CREATE TABLE "media"."files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"uploaded_by" uuid,
	"storage_key" text NOT NULL,
	"bucket" text NOT NULL,
	"original_name" text,
	"content_type" text NOT NULL,
	"size_bytes" bigint,
	"checksum" text,
	"kind" text DEFAULT 'upload' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"metadata" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "media"."files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."files" ADD CONSTRAINT "files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_tenant_created_idx" ON "media"."files" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "files_status_idx" ON "media"."files" USING btree ("status");--> statement-breakpoint
CREATE INDEX "files_expires_at_idx" ON "media"."files" USING btree ("expires_at");
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
ALTER TABLE "media"."files" DROP CONSTRAINT "files_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "media"."files" DROP CONSTRAINT "files_uploaded_by_users_id_fk";
--> statement-breakpoint
DROP INDEX "media"."files_tenant_created_idx";--> statement-breakpoint
ALTER TABLE "media"."user_files" ADD CONSTRAINT "user_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."user_files" ADD CONSTRAINT "user_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."user_files" ADD CONSTRAINT "user_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "media"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_files_tenant_created_idx" ON "media"."user_files" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_files_file_idx" ON "media"."user_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "user_files_uploaded_by_idx" ON "media"."user_files" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "files_checksum_idx" ON "media"."files" USING btree ("checksum");--> statement-breakpoint
ALTER TABLE "media"."files" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "media"."files" DROP COLUMN "uploaded_by";--> statement-breakpoint
ALTER TABLE "media"."files" DROP COLUMN "original_name";--> statement-breakpoint
ALTER TABLE "media"."files" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "media"."files" DROP COLUMN "visibility";--> statement-breakpoint
ALTER TABLE "media"."files" DROP COLUMN "metadata";
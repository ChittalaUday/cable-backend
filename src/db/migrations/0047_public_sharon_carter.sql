ALTER TABLE "auth"."devices" ADD COLUMN "push_token" text;--> statement-breakpoint
ALTER TABLE "auth"."devices" ADD COLUMN "push_token_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth"."devices" ADD COLUMN "last_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "notify"."notifications" ADD COLUMN "category" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "notify"."notifications" ADD COLUMN "delivery" text DEFAULT 'notification' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."devices" ADD CONSTRAINT "devices_last_tenant_id_tenants_id_fk" FOREIGN KEY ("last_tenant_id") REFERENCES "tenancy"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_push_token_idx" ON "auth"."devices" USING btree ("last_tenant_id") WHERE "auth"."devices"."push_token" IS NOT NULL AND "auth"."devices"."blocked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_pending_in_app_idx" ON "notify"."notifications" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE "notify"."notifications"."delivery" = 'in_app' AND "notify"."notifications"."read_at" IS NULL;
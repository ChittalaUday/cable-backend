ALTER TABLE "crm"."customers" DROP CONSTRAINT "customers_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "iam"."roles" DROP CONSTRAINT "roles_tenant_id_tenants_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "crm"."channels_service_number_idx";--> statement-breakpoint
DROP INDEX "iam"."roles_tenant_id_idx";--> statement-breakpoint
ALTER TABLE "crm"."customers" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "otp_codes_one_active_idx" ON "auth"."otp_codes" USING btree ("identifier","purpose") WHERE "auth"."otp_codes"."consumed_at" IS NULL AND "auth"."otp_codes"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sessions_active_prev_token_idx" ON "auth"."sessions" USING btree ("prev_token_hash") WHERE "auth"."sessions"."revoked_at" IS NULL AND "auth"."sessions"."prev_token_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "iam"."roles" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "iam"."roles" DROP COLUMN "is_system";--> statement-breakpoint
DELETE FROM "iam"."role_permissions" WHERE "role_id" = 'super_admin';--> statement-breakpoint
DELETE FROM "iam"."roles" WHERE "id" = 'super_admin';--> statement-breakpoint
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_known_scope" CHECK ("scope" IN ('OWN', 'ASSIGNED', 'TEAM', 'AREA', 'LOCATION', 'ALL'));--> statement-breakpoint
ALTER TABLE "iam"."roles" ADD CONSTRAINT "roles_known_id" CHECK ("id" IN ('admin', 'staff', 'customer'));--> statement-breakpoint

-- Reconcile the real migration chain with the Drizzle snapshots. Migration
-- 0007 moved these columns to package_channels, while 0008's snapshot moved
-- them back without emitting the matching SQL.
ALTER TABLE "crm"."channels" ADD COLUMN IF NOT EXISTS "service_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."channels" ADD COLUMN IF NOT EXISTS "channel_number" integer;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'crm' AND table_name = 'package_channels' AND column_name = 'channel_number'
  ) THEN
    EXECUTE '
      UPDATE "crm"."channels" AS c
      SET "service_id" = p."service_id",
          "channel_number" = pc."channel_number"
      FROM "crm"."package_channels" AS pc
      JOIN "crm"."packages" AS p ON p."id" = pc."package_id"
      WHERE pc."channel_id" = c."id"
        AND (c."service_id" IS NULL OR c."channel_number" IS NULL);
    ';
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "crm"."channels" ALTER COLUMN "service_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."channels" ALTER COLUMN "channel_number" SET NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_service_id_services_id_fk') THEN
    ALTER TABLE "crm"."channels"
      ADD CONSTRAINT "channels_service_id_services_id_fk"
      FOREIGN KEY ("service_id") REFERENCES "crm"."services"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_service_number_unq') THEN
    ALTER TABLE "crm"."channels"
      ADD CONSTRAINT "channels_service_number_unq" UNIQUE ("service_id", "channel_number");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_service_slug_unq') THEN
    ALTER TABLE "crm"."channels"
      ADD CONSTRAINT "channels_service_slug_unq" UNIQUE ("service_id", "slug");
  END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "channels_service_idx" ON "crm"."channels" ("service_id");--> statement-breakpoint
ALTER TABLE "crm"."package_channels" DROP COLUMN IF EXISTS "channel_number";--> statement-breakpoint
ALTER TABLE "crm"."package_channels" DROP COLUMN IF EXISTS "metadata";

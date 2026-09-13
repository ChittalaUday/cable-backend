DROP INDEX "crm"."channels_tenant_number_idx";--> statement-breakpoint
ALTER TABLE "crm"."customer_details" ALTER COLUMN "alternate_phone" SET DATA TYPE varchar(10);--> statement-breakpoint
ALTER TABLE "crm"."customer_details" ALTER COLUMN "whatsapp_number" SET DATA TYPE varchar(10);--> statement-breakpoint
ALTER TABLE "crm"."customers" ALTER COLUMN "phone" SET DATA TYPE varchar(10);--> statement-breakpoint
ALTER TABLE "auth"."users" ALTER COLUMN "phone" SET DATA TYPE varchar(10);--> statement-breakpoint
ALTER TABLE "crm"."package_channels" ADD COLUMN "channel_number" integer;--> statement-breakpoint
ALTER TABLE "crm"."package_channels" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
CREATE INDEX "package_channels_pkg_number_idx" ON "crm"."package_channels" USING btree ("package_id","channel_number");--> statement-breakpoint
ALTER TABLE "crm"."channels" DROP COLUMN "channel_number";--> statement-breakpoint
ALTER TABLE "crm"."package_channels" DROP COLUMN "channel_number_override";--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_phone_ten_digits" CHECK ("crm"."customers"."phone" IS NULL OR "crm"."customers"."phone" ~ '^[0-9]{10}$');--> statement-breakpoint
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_phone_ten_digits" CHECK ("auth"."users"."phone" IS NULL OR "auth"."users"."phone" ~ '^[0-9]{10}$');
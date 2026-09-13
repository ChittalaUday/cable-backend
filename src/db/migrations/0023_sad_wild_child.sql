ALTER TABLE "crm"."channels" DROP CONSTRAINT "channels_service_number_unq";--> statement-breakpoint
ALTER TABLE "crm"."channels" DROP CONSTRAINT "channels_service_slug_unq";--> statement-breakpoint
ALTER TABLE "crm"."channels" DROP CONSTRAINT "channels_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "crm"."packages" DROP CONSTRAINT "packages_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" DROP CONSTRAINT "subscriptions_service_id_services_id_fk";
--> statement-breakpoint
DROP INDEX "crm"."channels_service_idx";--> statement-breakpoint
DROP INDEX "crm"."packages_tenant_service_idx";--> statement-breakpoint
DROP INDEX "crm"."packages_tenant_slug_idx";--> statement-breakpoint
DROP INDEX "crm"."subscriptions_tenant_service_idx";--> statement-breakpoint
ALTER TABLE "crm"."channels" ALTER COLUMN "service_provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."packages" ALTER COLUMN "service_provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ALTER COLUMN "service_provider_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "channels_provider_idx" ON "crm"."channels" USING btree ("service_provider_id");--> statement-breakpoint
CREATE INDEX "packages_tenant_provider_idx" ON "crm"."packages" USING btree ("tenant_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_provider_idx" ON "crm"."subscriptions" USING btree ("tenant_id","service_provider_id");--> statement-breakpoint
ALTER TABLE "crm"."channels" DROP COLUMN "service_id";--> statement-breakpoint
ALTER TABLE "crm"."packages" DROP COLUMN "service_id";--> statement-breakpoint
ALTER TABLE "crm"."services" DROP COLUMN "provider_name";--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" DROP COLUMN "service_id";--> statement-breakpoint
ALTER TABLE "crm"."channels" ADD CONSTRAINT "channels_provider_number_unq" UNIQUE("service_provider_id","channel_number");--> statement-breakpoint
ALTER TABLE "crm"."channels" ADD CONSTRAINT "channels_provider_slug_unq" UNIQUE("service_provider_id","slug");--> statement-breakpoint
ALTER TABLE "crm"."packages" ADD CONSTRAINT "packages_provider_slug_uq" UNIQUE("service_provider_id","slug");
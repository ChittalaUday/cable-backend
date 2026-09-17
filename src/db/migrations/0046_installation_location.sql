-- crm/subscriptions.ts has called this column `installation_location_id` since
-- the schema was restructured; the migration for the rename was never
-- generated, so every read of crm.subscriptions through Drizzle — including
-- GET /customers — has been failing with 42703.
ALTER TABLE "crm"."subscriptions" RENAME COLUMN "location_id" TO "installation_location_id";--> statement-breakpoint
ALTER INDEX "crm"."subscriptions_location_idx" RENAME TO "subscriptions_installation_location_idx";--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" RENAME CONSTRAINT "subscriptions_location_id_locations_id_fk" TO "subscriptions_installation_location_id_locations_id_fk";

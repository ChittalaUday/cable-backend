ALTER TABLE "crm"."customers" DROP CONSTRAINT "customers_location_id_locations_id_fk";
--> statement-breakpoint
DROP INDEX "crm"."customers_location_idx";--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD COLUMN "outstanding_balance" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."customers" DROP COLUMN "location_id";

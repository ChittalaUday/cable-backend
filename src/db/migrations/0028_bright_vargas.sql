-- One address per subscription, and it is a location node.
--
-- `crm.customer_addresses` held a second, parallel copy of where a customer is:
-- its own lat/long, its own free-text city and pincode, and an `is_primary`
-- flag deciding which of them counted. `geo.locations` already answers that
-- question, and coverage, routing and area-scoped permissions all read the
-- location tree — so the address table was a source of truth nothing trusted.
--
-- What is left: `customers.location_id` (structured, queried) plus
-- `customers.address` (free text, never queried), and the same pair on a
-- subscription, where the node is required because a line has to terminate
-- somewhere.

--> ─── backfill, before the table that holds the data is dropped ───

ALTER TABLE "crm"."customers" ADD COLUMN "address" text;--> statement-breakpoint

-- Flatten the primary address into the one free-text column that replaces it.
UPDATE "crm"."customers" c
SET "address" = NULLIF(
  concat_ws(', ',
    NULLIF(a."flat_or_door_no", ''),
    NULLIF(a."building_or_apartment", ''),
    NULLIF(a."street_or_road", ''),
    NULLIF(a."landmark", ''),
    NULLIF(a."area", ''),
    NULLIF(a."city", ''),
    NULLIF(a."pincode", '')
  ), '')
FROM (
  SELECT DISTINCT ON ("customer_id") "customer_id", "flat_or_door_no", "building_or_apartment",
         "street_or_road", "landmark", "area", "city", "pincode"
  FROM "crm"."customer_addresses"
  ORDER BY "customer_id", "is_primary" DESC, "created_at"
) a
WHERE a."customer_id" = c."id" AND c."address" IS NULL;
--> statement-breakpoint

-- A customer with no node of its own inherits the one its address pointed at.
UPDATE "crm"."customers" c
SET "location_id" = a."location_id"
FROM (
  SELECT DISTINCT ON ("customer_id") "customer_id", "location_id"
  FROM "crm"."customer_addresses"
  WHERE "location_id" IS NOT NULL
  ORDER BY "customer_id", "is_primary" DESC, "created_at"
) a
WHERE a."customer_id" = c."id" AND c."location_id" IS NULL;
--> statement-breakpoint

--> ─── subscriptions.location_id: added nullable, backfilled, then required ───

ALTER TABLE "crm"."subscriptions" ADD COLUMN "location_id" uuid;--> statement-breakpoint

UPDATE "crm"."subscriptions" s
SET "location_id" = a."location_id"
FROM "crm"."customer_addresses" a
WHERE a."id" = s."installation_address_id" AND a."location_id" IS NOT NULL AND s."location_id" IS NULL;
--> statement-breakpoint

UPDATE "crm"."subscriptions" s
SET "location_id" = c."location_id"
FROM "crm"."customers" c
WHERE c."id" = s."customer_id" AND c."location_id" IS NOT NULL AND s."location_id" IS NULL;
--> statement-breakpoint

-- Imported rows that never had a node land on their tenant's first root area.
-- Wrong-but-present beats blocking the constraint; a tenant with no locations
-- at all fails the NOT NULL below, loudly, which is the right outcome.
UPDATE "crm"."subscriptions" s
SET "location_id" = (
  SELECT l."id" FROM "geo"."locations" l
  WHERE l."tenant_id" = s."tenant_id" AND l."parent_id" IS NULL
  ORDER BY l."created_at"
  LIMIT 1
)
WHERE s."location_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "crm"."subscriptions" ALTER COLUMN "location_id" SET NOT NULL;--> statement-breakpoint

--> ─── the old address table goes ───

ALTER TABLE "crm"."customer_addresses" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "crm"."customer_addresses" CASCADE;--> statement-breakpoint
ALTER TABLE "crm"."customers" DROP CONSTRAINT "customers_area_id_locations_id_fk";
--> statement-breakpoint
DROP INDEX "crm"."customers_area_idx";--> statement-breakpoint
DROP INDEX "crm"."subscriptions_address_idx";--> statement-breakpoint

--> ─── the rest ───

ALTER TABLE "auth"."devices" ADD COLUMN "ram_mb" integer;--> statement-breakpoint
ALTER TABLE "auth"."devices" ADD COLUMN "screen_resolution" text;--> statement-breakpoint
ALTER TABLE "media"."files" ADD COLUMN "checksum_algorithm" text;--> statement-breakpoint
ALTER TABLE "notify"."notifications" ADD COLUMN "file_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" ADD CONSTRAINT "subscriptions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify"."notifications" ADD CONSTRAINT "notifications_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "media"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_location_idx" ON "crm"."subscriptions" USING btree ("location_id");--> statement-breakpoint
ALTER TABLE "crm"."customers" DROP COLUMN "area_id";--> statement-breakpoint
ALTER TABLE "crm"."subscriptions" DROP COLUMN "installation_address_id";

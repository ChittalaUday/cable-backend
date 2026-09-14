ALTER TABLE "crm"."customers" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD COLUMN "phone" varchar(10);--> statement-breakpoint
CREATE INDEX "customers_tenant_name_idx" ON "crm"."customers" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "customers_tenant_phone_idx" ON "crm"."customers" USING btree ("tenant_id","phone");--> statement-breakpoint
-- Backfill from where the MSO import left them, so the new columns are not
-- empty for the 764 rows that already exist. `cleanedPhone` is the 10-digit
-- national number the importer derived; `mobileNo` carries the country code.
UPDATE "crm"."customers"
SET "name" = nullif(trim("metadata"->>'name'), ''),
    "phone" = nullif(regexp_replace(coalesce("metadata"->>'cleanedPhone', ''), '\D', '', 'g'), '')
WHERE "metadata" IS NOT NULL
  AND "name" IS NULL;

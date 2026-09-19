ALTER TABLE "billing"."collections"
  ADD COLUMN IF NOT EXISTS "accessory_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing"."collections"
  ADD COLUMN IF NOT EXISTS "accessories" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- `total_collected` was generated from dues alone, so an accessory sold on the
-- visit was charged to the account but never showed on the receipt. It is the
-- whole of what the collector took.
ALTER TABLE "billing"."collections" DROP COLUMN IF EXISTS "total_collected";--> statement-breakpoint
ALTER TABLE "billing"."collections"
  ADD COLUMN "total_collected" numeric(12, 2)
  GENERATED ALWAYS AS ("dues_paid" + "accessory_amount") STORED NOT NULL;--> statement-breakpoint

ALTER TABLE "billing"."collections"
  ADD CONSTRAINT "collections_accessories_not_negative"
  CHECK ("outcome" = 'refund' OR "accessory_amount" >= 0);--> statement-breakpoint

-- A collection is a ledger entry: it is corrected by a reversal row, never by
-- editing or removing the original. The service already refuses both, and
-- there is no route for either — this makes it true of anything that reaches
-- the table, including a hand-written statement.
CREATE OR REPLACE FUNCTION billing.collections_refuse_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'billing.collections is append-only: reverse the receipt instead of %ing it',
    lower(TG_OP)
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS collections_append_only ON billing.collections;--> statement-breakpoint
CREATE TRIGGER collections_append_only
  BEFORE UPDATE OR DELETE ON billing.collections
  FOR EACH ROW EXECUTE FUNCTION billing.collections_refuse_change();

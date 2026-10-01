UPDATE "tenancy"."tenant_upi_accounts"
SET "is_default" = false, "updated_at" = now()
WHERE "tenant_id" = (SELECT "id" FROM "tenancy"."tenants" WHERE "code" = 'SSCN');
--> statement-breakpoint
INSERT INTO "tenancy"."tenant_upi_accounts" (
  "tenant_id",
  "upi_id",
  "payee_name",
  "label",
  "is_default",
  "status"
)
SELECT
  "id",
  '9951179664@ybl',
  'Sri Satya Cable Network',
  'Primary QR',
  true,
  'active'
FROM "tenancy"."tenants"
WHERE "code" = 'SSCN'
ON CONFLICT ("tenant_id", "upi_id") WHERE "deleted_at" IS NULL
DO UPDATE SET
  "payee_name" = excluded."payee_name",
  "label" = excluded."label",
  "is_default" = true,
  "status" = 'active',
  "updated_at" = now();

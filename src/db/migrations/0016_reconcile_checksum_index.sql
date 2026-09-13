DROP INDEX IF EXISTS "media"."files_checksum_idx";
--> statement-breakpoint
WITH ranked AS (
  SELECT
    "id",
    first_value("id") OVER (
      PARTITION BY "checksum"
      ORDER BY ("status" = 'ready') DESC, "created_at", "id"
    ) AS canonical_id
  FROM "media"."files"
  WHERE "checksum" IS NOT NULL AND "deleted_at" IS NULL
)
UPDATE "media"."user_files" AS uf
SET "file_id" = ranked."canonical_id", "updated_at" = now()
FROM ranked
WHERE uf."file_id" = ranked."id" AND ranked."id" <> ranked."canonical_id";
--> statement-breakpoint
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "checksum"
      ORDER BY ("status" = 'ready') DESC, "created_at", "id"
    ) AS position
  FROM "media"."files"
  WHERE "checksum" IS NOT NULL AND "deleted_at" IS NULL
)
UPDATE "media"."files" AS f
SET "status" = 'deleted', "deleted_at" = now(), "updated_at" = now()
FROM ranked
WHERE f."id" = ranked."id" AND ranked.position > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "files_checksum_unq"
ON "media"."files" ("checksum")
WHERE "checksum" IS NOT NULL AND "deleted_at" IS NULL;

ALTER TABLE "geo"."locations" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo"."location_categories" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo"."location_schemas" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "geo"."locations" DROP CONSTRAINT IF EXISTS "locations_parent_name_uq";--> statement-breakpoint
ALTER TABLE "geo"."location_categories" DROP CONSTRAINT IF EXISTS "location_categories_tenant_slug_uq";--> statement-breakpoint
ALTER TABLE "geo"."location_schemas" DROP CONSTRAINT IF EXISTS "location_schemas_tenant_slug_uq";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "locations_parent_name_uq"
  ON "geo"."locations" ("tenant_id", coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), "name")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "location_categories_tenant_slug_uq"
  ON "geo"."location_categories" ("tenant_id", "slug")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "location_schemas_tenant_slug_uq"
  ON "geo"."location_schemas" ("tenant_id", "slug")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locations_tenant_live_idx"
  ON "geo"."locations" ("tenant_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- A deleted node takes its whole subtree out of the walk: the recursive step
-- only follows live children, so a live row orphaned under a deleted parent
-- disappears with it rather than re-rooting itself.
CREATE OR REPLACE FUNCTION geo.location_descendants(root uuid)
RETURNS TABLE (id uuid, depth integer)
LANGUAGE sql
STABLE
PARALLEL SAFE
ROWS 100
AS $$
  WITH RECURSIVE tree AS (
    SELECT l.id, 0 AS depth
    FROM geo.locations l
    WHERE l.id = root AND l.deleted_at IS NULL

    UNION ALL

    SELECT child.id, tree.depth + 1
    FROM geo.locations child
    JOIN tree ON child.parent_id = tree.id
    WHERE child.deleted_at IS NULL
  ) CYCLE id SET is_cycle USING visited
  SELECT tree.id, tree.depth FROM tree WHERE NOT is_cycle
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION geo.location_ancestors(node uuid)
RETURNS TABLE (id uuid, depth integer)
LANGUAGE sql
STABLE
PARALLEL SAFE
ROWS 8
AS $$
  WITH RECURSIVE chain AS (
    SELECT l.id, l.parent_id, 0 AS depth
    FROM geo.locations l
    WHERE l.id = node AND l.deleted_at IS NULL

    UNION ALL

    SELECT parent.id, parent.parent_id, chain.depth + 1
    FROM geo.locations parent
    JOIN chain ON chain.parent_id = parent.id
    WHERE parent.deleted_at IS NULL
  ) CYCLE id SET is_cycle USING visited
  SELECT chain.id, chain.depth FROM chain WHERE NOT is_cycle
$$;--> statement-breakpoint

-- `codes` was declared on the Drizzle view but never produced here, so every
-- read that selected it failed at the database. It is the code of each node
-- along the path, root first, with unnamed nodes left out rather than blank.
DROP VIEW IF EXISTS geo.location_paths;--> statement-breakpoint
CREATE VIEW geo.location_paths AS
WITH RECURSIVE walk AS (
  SELECT
    l.id,
    l.tenant_id,
    l.id                       AS root_id,
    0                          AS depth,
    ARRAY[l.id]                AS path_ids,
    l.name                     AS path,
    CASE WHEN l.code IS NULL THEN ARRAY[]::text[] ELSE ARRAY[l.code] END AS codes
  FROM geo.locations l
  WHERE l.parent_id IS NULL AND l.deleted_at IS NULL

  UNION ALL

  SELECT
    child.id,
    child.tenant_id,
    walk.root_id,
    walk.depth + 1,
    walk.path_ids || child.id,
    walk.path || ' / ' || child.name,
    CASE WHEN child.code IS NULL THEN walk.codes ELSE walk.codes || child.code END
  FROM geo.locations child
  JOIN walk ON child.parent_id = walk.id
  WHERE child.deleted_at IS NULL
) CYCLE id SET is_cycle USING visited
SELECT id, tenant_id, root_id, depth, path_ids, path, codes
FROM walk
WHERE NOT is_cycle;

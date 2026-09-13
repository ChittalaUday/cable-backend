-- Tree walking for the tenant-configurable location hierarchy (AGENTS.md §8.3, §8.6).
--
-- These exist in the database because other QUERIES need them: filtering
-- customers to a subtree is `location_id IN (SELECT id FROM
-- geo.location_descendants($1))`, and every caller writing that recursive CTE by
-- hand is the same query typed five ways, four of them missing the cycle guard.
--
-- No business rule lives here. Depth is data, and neither function knows what a
-- "floor" or a "door" is.

-- Every node from `root` down, INCLUDING the node itself, so a subtree filter
-- covers customers sitting on the node it was given.
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
    WHERE l.id = root

    UNION ALL

    SELECT child.id, tree.depth + 1
    FROM geo.locations child
    JOIN tree ON child.parent_id = tree.id
  ) CYCLE id SET is_cycle USING visited
  SELECT tree.id, tree.depth FROM tree WHERE NOT is_cycle
$$;
--> statement-breakpoint

-- Every node from `node` up to its root, INCLUDING the node itself.
-- `depth` is 0 at the node and increases toward the root, so the breadcrumb is
-- `ORDER BY depth DESC`.
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
    WHERE l.id = node

    UNION ALL

    SELECT parent.id, parent.parent_id, chain.depth + 1
    FROM geo.locations parent
    JOIN chain ON chain.parent_id = parent.id
  ) CYCLE id SET is_cycle USING visited
  SELECT chain.id, chain.depth FROM chain WHERE NOT is_cycle
$$;
--> statement-breakpoint

-- ─── Read model ───────────────────────────────────────────────────────────────

-- The full path of every node, resolved once instead of N queries per row:
-- breadcrumbs in the UI, "Mandapeta / Sri Sai Apartments / Block A / A101" in a
-- search result, and `root_id` for a cheap top-level filter.
CREATE OR REPLACE VIEW geo.location_paths AS
WITH RECURSIVE walk AS (
  SELECT
    l.id,
    l.tenant_id,
    l.id                       AS root_id,
    0                          AS depth,
    ARRAY[l.id]                AS path_ids,
    l.name                     AS path
  FROM geo.locations l
  WHERE l.parent_id IS NULL

  UNION ALL

  SELECT
    child.id,
    child.tenant_id,
    walk.root_id,
    walk.depth + 1,
    walk.path_ids || child.id,
    walk.path || ' / ' || child.name
  FROM geo.locations child
  JOIN walk ON child.parent_id = walk.id
) CYCLE id SET is_cycle USING visited
SELECT id, tenant_id, root_id, depth, path_ids, path
FROM walk
WHERE NOT is_cycle;
--> statement-breakpoint

-- Fuzzy building/flat search over the tenant's tree (§2: pg_trgm, no cluster).
CREATE INDEX IF NOT EXISTS locations_name_trgm_idx
  ON geo.locations USING gin (name gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS location_aliases_trgm_idx
  ON geo.location_aliases USING gin (alias gin_trgm_ops);
--> statement-breakpoint

-- ─── Deferred integrity ───────────────────────────────────────────────────────

-- These four keys must refuse to orphan a row, but they must not fire mid-way
-- through an unrelated cascade: deleting a TENANT cascades into categories,
-- schemas, levels and nodes in an order Postgres picks, and an immediate check
-- fails on a row whose referent is about to be deleted in the same statement.
--
-- DEFERRABLE INITIALLY DEFERRED moves the check to commit. Deleting a category
-- a level still uses, or a node that still has children, is still refused —
-- just at the end of the statement instead of the middle of it.
ALTER TABLE geo.location_schema_levels
  ALTER CONSTRAINT location_schema_levels_category_id_location_categories_id_fk DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

ALTER TABLE geo.locations
  ALTER CONSTRAINT locations_category_id_location_categories_id_fk DEFERRABLE INITIALLY DEFERRED,
  ALTER CONSTRAINT locations_schema_id_location_schemas_id_fk DEFERRABLE INITIALLY DEFERRED,
  ALTER CONSTRAINT locations_parent_id_locations_id_fk DEFERRABLE INITIALLY DEFERRED;

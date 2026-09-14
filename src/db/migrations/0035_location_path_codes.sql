CREATE OR REPLACE VIEW geo.location_paths AS
WITH RECURSIVE walk AS (
  SELECT
    l.id,
    l.tenant_id,
    l.id AS root_id,
    0 AS depth,
    ARRAY[l.id] AS path_ids,
    l.name AS path,
    array_remove(ARRAY[l.code::text], NULL) AS codes
  FROM geo.locations l
  WHERE l.parent_id IS NULL

  UNION ALL

  SELECT
    child.id,
    child.tenant_id,
    walk.root_id,
    walk.depth + 1,
    walk.path_ids || child.id,
    walk.path || ' / ' || child.name,
    walk.codes || array_remove(ARRAY[child.code::text], NULL)
  FROM geo.locations child
  JOIN walk ON child.parent_id = walk.id
) CYCLE id SET is_cycle USING visited
SELECT id, tenant_id, root_id, depth, path_ids, path, codes
FROM walk
WHERE NOT is_cycle;

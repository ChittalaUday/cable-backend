-- Coverage resolution, in one place (docs/services-providers-packages.md §5).
--
-- Three rules, and nothing else:
--
-- 1. **A list of places means only those places.** Once a level names somewhere
--    it sells, it sells nowhere else — otherwise "ACT serves Mandapeta" would
--    also serve the next town over, and two same-named packages for two areas
--    would both be sold in both.
-- 2. **Within a level the nearest ancestor wins.** A row covers its node and
--    everything below it, so one `is_available = false` row on Block C carves a
--    hole out of a `true` row on Mandapeta without enumerating the streets.
-- 3. **A parent bounds its children.** The service's answer, the provider's and
--    the package's are ANDed, so a service switched off in Block C takes every
--    provider and package under it with it.
--
-- A level with no rows at all says nothing, and a level with only `false` rows
-- is a pure carve-out — "everywhere except Block C" — so neither turns into an
-- allowlist. That is what keeps a tenant who has configured nothing selling
-- everywhere.
--
-- It lives in SQL because four callers need the same answer: the wizard's
-- availability list, the subscription check, the write-time validation that
-- stops a child being pointed outside its parent, and the location picker that
-- only offers what the parent allows.
CREATE OR REPLACE FUNCTION crm.coverage_allows(
  p_tenant   uuid,
  p_service  uuid,
  p_provider uuid,
  p_package  uuid,
  p_location uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  WITH chain AS (
    SELECT id, depth FROM geo.location_ancestors(p_location)
  ),
  -- Every row that has a say here: the service's, and the ones belonging to the
  -- provider and package actually being asked about.
  scoped AS (
    SELECT c.service_provider_id, c.package_id, c.location_id, c.is_available
    FROM crm.service_coverage c
    WHERE c.tenant_id = p_tenant
      AND c.service_id = p_service
      AND (c.service_provider_id IS NULL OR c.service_provider_id = p_provider)
      AND (c.package_id IS NULL OR c.package_id = p_package)
  ),
  -- At most three rows: one per level that has said anything at all.
  levels AS (
    SELECT
      bool_or(s.is_available) AS has_allowlist,
      (
        SELECT n.is_available
        FROM scoped n
        JOIN chain ON chain.id = n.location_id
        WHERE n.service_provider_id IS NOT DISTINCT FROM s.service_provider_id
          AND n.package_id IS NOT DISTINCT FROM s.package_id
        ORDER BY chain.depth
        LIMIT 1
      ) AS nearest
    FROM scoped s
    GROUP BY s.service_provider_id, s.package_id
  )
  -- Outside an allowlist is a no; outside a pure carve-out is a yes; and no
  -- level having spoken at all leaves `bool_and` NULL, which is also a yes.
  SELECT bool_and(coalesce(nearest, NOT has_allowlist)) IS NOT FALSE FROM levels
$$;

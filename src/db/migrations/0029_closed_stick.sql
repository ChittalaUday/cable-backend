-- AREA and LOCATION were one grant wearing two hats.
--
-- Both were subtree grants over `geo.locations`, resolved the same way through
-- `location_ancestors`, and `grantedNodes` already handed LOCATION the union of
-- the two sets — so an AREA grant never reached anything a LOCATION grant did
-- not. The only thing separating them was the claim that an "area" is coarser,
-- which is the tenant's choice of node, not a second dimension.
--
-- So: `tenancy.membership_areas` goes, `AREA` leaves the scope ladder, and
-- every grant that had it becomes `LOCATION` — the same reach it already had.

--> ─── existing grants keep their reach, under the surviving name ───

-- Before the constraint below stops accepting 'AREA'. A role holding both
-- would end up with two rows for one permission key, which the primary key on
-- (role_id, permission_key) forbids — so the duplicate is dropped and the
-- wider of the two survives, which is LOCATION either way.
DELETE FROM iam.role_permissions a
WHERE a.scope = 'AREA'
  AND EXISTS (
    SELECT 1 FROM iam.role_permissions b
    WHERE b.role_id = a.role_id AND b.permission_key = a.permission_key AND b.scope = 'LOCATION'
  );
--> statement-breakpoint

UPDATE iam.role_permissions SET scope = 'LOCATION' WHERE scope = 'AREA';
--> statement-breakpoint

ALTER TABLE "iam"."role_permissions" DROP CONSTRAINT "role_permissions_known_scope";--> statement-breakpoint
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_known_scope" CHECK ("scope" IN ('OWN', 'ASSIGNED', 'TEAM', 'LOCATION', 'ALL'));--> statement-breakpoint

--> ─── the ladder loses a rung, in both copies at once ───

-- Kept in lockstep with SCOPE_RANK in shared/security/permissions.ts; a test
-- asserts the two agree, because two copies of a privilege ranking that drift
-- is a security bug.
CREATE OR REPLACE FUNCTION iam.scope_rank(scope text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE scope
    WHEN 'OWN'      THEN 1
    WHEN 'ASSIGNED' THEN 2
    WHEN 'TEAM'     THEN 3
    WHEN 'LOCATION' THEN 4
    WHEN 'ALL'      THEN 5
    ELSE 0
  END
$$;
--> statement-breakpoint

--> ─── the second grant table goes ───

-- Any subtree a membership held here it can hold in `membership_locations`;
-- the rows move rather than being dropped, so nobody silently loses access.
INSERT INTO tenancy.membership_locations (membership_id, location_id)
SELECT membership_id, area_id FROM tenancy.membership_areas
ON CONFLICT ON CONSTRAINT membership_locations_uq DO NOTHING;
--> statement-breakpoint

DROP TABLE "tenancy"."membership_areas" CASCADE;

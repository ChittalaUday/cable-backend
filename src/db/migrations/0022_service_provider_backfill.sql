-- Backfill: every existing service becomes a service + one provider
-- (docs/services-providers-packages.md §8).
--
-- Data only. The columns are already there and still nullable (0021), and they
-- are constrained in the migration after this one — add nullable, backfill,
-- then constrain (AGENTS.md §8).
--
-- `services.provider_name` was a text column, which is exactly the conflation
-- this change removes: `ACT Cable TV` was a service whose provider was
-- `ACT Digital`. The name moves onto the provider row; renaming the service
-- itself is a data decision, made in the seed, not here.

-- Soft-deleted services get a provider too, carrying the same `deleted_at`.
-- Skipping them would leave their packages and subscriptions with no provider,
-- and the NOT NULL in the next migration would then fail on rows nobody can
-- see — history has to migrate along with everything else.
INSERT INTO crm.service_providers (tenant_id, service_id, name, slug, description, metadata, status, is_default, deleted_at)
SELECT
  s.tenant_id,
  s.id,
  coalesce(nullif(s.provider_name, ''), s.name) AS name,
  -- Slug from the provider name, lowercased and hyphenated. It is unique per
  -- (tenant, service) and there is exactly one row per service here, so it
  -- cannot collide with itself.
  trim(both '-' from regexp_replace(
    lower(trim(coalesce(nullif(s.provider_name, ''), s.name))),
    '[^a-z0-9]+', '-', 'g'
  )) AS slug,
  s.description,
  s.metadata,
  s.status,
  true AS is_default,
  s.deleted_at
FROM crm.services s
WHERE NOT EXISTS (SELECT 1 FROM crm.service_providers p WHERE p.service_id = s.id);
--> statement-breakpoint

-- Everything that hung off a service now hangs off that service's one provider.
UPDATE crm.packages pk
SET service_provider_id = p.id
FROM crm.service_providers p
WHERE p.service_id = pk.service_id
  AND pk.service_provider_id IS NULL;
--> statement-breakpoint

UPDATE crm.channels ch
SET service_provider_id = p.id
FROM crm.service_providers p
WHERE p.service_id = ch.service_id
  AND ch.service_provider_id IS NULL;
--> statement-breakpoint

UPDATE crm.subscriptions sub
SET service_provider_id = p.id
FROM crm.service_providers p
WHERE p.service_id = sub.service_id
  AND sub.service_provider_id IS NULL;

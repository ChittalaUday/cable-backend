-- Functions and read models (AGENTS.md §8.3).
--
-- Only pure, deterministic helpers live in the database. Nothing here encodes a
-- business rule: a rule implemented in SQL as well as TypeScript is two
-- implementations that drift, out of reach of the linter and the tests.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- ─── Functions ────────────────────────────────────────────────────────────────

-- Digits only, no '+' and no separators.
-- This must exist in the database because an EXPRESSION INDEX needs it here:
-- searching for "83091 54716" has to hit a customer stored as "+91-8309154716",
-- and application code cannot supply a function to an index.
CREATE OR REPLACE FUNCTION crm.normalize_phone(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT regexp_replace(value, '[^0-9]', '', 'g')
$$;
--> statement-breakpoint

-- The §5 scope hierarchy as SQL. Mirrors SCOPE_RANK in
-- shared/security/permissions.ts; a test asserts the two agree, because two
-- copies of a privilege ranking that drift is a security bug.
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
    WHEN 'AREA'     THEN 4
    WHEN 'LOCATION' THEN 5
    WHEN 'ALL'      THEN 6
    ELSE 0
  END
$$;
--> statement-breakpoint

-- ─── Indexes that depend on those functions ───────────────────────────────────

CREATE INDEX IF NOT EXISTS customers_tenant_normalized_phone_idx
  ON crm.customers (tenant_id, crm.normalize_phone(phone));
--> statement-breakpoint

-- Fuzzy name search (§2: pg_trgm, not a search cluster).
CREATE INDEX IF NOT EXISTS customers_name_trgm_idx
  ON crm.customers USING gin (name gin_trgm_ops);
--> statement-breakpoint

-- The unread-badge query, so it never scans a customer's whole history.
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON notify.notifications (tenant_id, user_id)
  WHERE channel = 'in_app' AND read_at IS NULL;
--> statement-breakpoint

-- ─── Read models ──────────────────────────────────────────────────────────────

-- Per-tenant customer counts and dues: the dashboard aggregate, as one row per
-- tenant instead of every customer row read into the application.
CREATE OR REPLACE VIEW analytics.tenant_customer_stats AS
SELECT
  t.id                                                                      AS tenant_id,
  t.code                                                                    AS tenant_code,
  count(c.id)::int                                                          AS total_customers,
  count(c.id) FILTER (WHERE c.status = 'active')::int                       AS active_customers,
  count(c.id) FILTER (WHERE c.status = 'inactive')::int                     AS inactive_customers,
  count(c.id) FILTER (WHERE c.status = 'pending')::int                      AS pending_customers,
  count(c.id) FILTER (WHERE c.created_at >= date_trunc('month', now()))::int AS added_this_month,
  coalesce(sum(c.outstanding_balance), 0)::numeric(14, 2)                   AS outstanding_total
FROM tenancy.tenants t
LEFT JOIN crm.customers c
  ON c.tenant_id = t.id AND c.deleted_at IS NULL
WHERE t.deleted_at IS NULL
GROUP BY t.id, t.code;
--> statement-breakpoint

-- Unread in-app notifications per (tenant, user). One definition of the badge
-- count, rather than a filter every caller retypes and eventually gets wrong.
CREATE OR REPLACE VIEW notify.user_unread_counts AS
SELECT
  n.tenant_id,
  n.user_id,
  count(*)::int  AS unread_count,
  max(n.created_at) AS latest_at
FROM notify.notifications n
WHERE n.channel = 'in_app'
  AND n.read_at IS NULL
  AND n.tenant_id IS NOT NULL
  AND n.user_id IS NOT NULL
GROUP BY n.tenant_id, n.user_id;
--> statement-breakpoint

-- Delivery outcomes per channel over 24h. A disconnected WhatsApp session shows
-- up here as a failure rate rather than as users quietly not getting OTPs.
CREATE OR REPLACE VIEW analytics.messaging_health AS
SELECT
  n.channel,
  count(*) FILTER (WHERE n.status = 'sent')::int   AS sent,
  count(*) FILTER (WHERE n.status = 'failed')::int AS failed,
  count(*) FILTER (WHERE n.status = 'queued')::int AS queued,
  (count(*) FILTER (WHERE n.status = 'failed') * 10 <= count(*)) AS healthy
FROM notify.notifications n
WHERE n.created_at >= now() - interval '24 hours'
GROUP BY n.channel;

-- Email is one address, whatever case somebody typed it in.
--
-- `auth.login` lowercases the identifier before it looks anybody up, but
-- nothing lowercased it on the way in and `users.email` carries a plain
-- case-sensitive unique index. So an account created as `Ravi@X.com` could
-- never sign in — the lookup asked for `ravi@x.com` and the row said
-- `Ravi@X.com` — and two people could hold the same address in two cases.
--
-- The canonical form is a function, and a CHECK constraint holds the column to
-- it. Not a trigger: a trigger rewrites the row silently, so a caller that
-- forgot to normalise keeps working and nobody finds out until the rule moves.
-- A constraint refuses the write, which is a failing test the same afternoon.
-- `shared/utils/email.ts` is the same rule in TypeScript; the constraint is
-- what makes the two stay the same rule.
UPDATE auth.users u
SET email = lower(btrim(u.email))
WHERE u.email IS DISTINCT FROM lower(btrim(u.email))
  AND NOT EXISTS (
    SELECT 1 FROM auth.users other
    WHERE other.id <> u.id AND other.email = lower(btrim(u.email))
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth.normalise_email(address text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$ SELECT nullif(lower(btrim(address)), '') $$;
--> statement-breakpoint
ALTER TABLE auth.users
  ADD CONSTRAINT users_email_normalised
  CHECK (email IS NULL OR email = auth.normalise_email(email));

ALTER TABLE "tenancy"."teams" ADD COLUMN "leader_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "tenancy"."teams" ADD CONSTRAINT "teams_leader_membership_id_tenant_memberships_id_fk" FOREIGN KEY ("leader_membership_id") REFERENCES "tenancy"."tenant_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Carry each crew's existing leader over. A crew kept only one flagged leader
-- in practice; if more than one was flagged, the earliest membership wins.
UPDATE "tenancy"."teams" t
SET "leader_membership_id" = (
  SELECT m."id" FROM "tenancy"."tenant_memberships" m
  WHERE m."team_id" = t."id" AND m."is_team_leader"
  ORDER BY m."created_at", m."id"
  LIMIT 1
);--> statement-breakpoint
ALTER TABLE "tenancy"."tenant_memberships" DROP COLUMN "is_team_leader";--> statement-breakpoint
ALTER TABLE "tenancy"."teams" ADD CONSTRAINT "teams_leader_membership_uq" UNIQUE("leader_membership_id");
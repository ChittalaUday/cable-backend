CREATE TABLE "tenancy"."team_member_locations" (
	"membership_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "team_member_locations_uq" UNIQUE("membership_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "tenancy"."tenant_memberships" ADD COLUMN "is_team_leader" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenancy"."team_member_locations" ADD CONSTRAINT "team_member_locations_membership_id_tenant_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "tenancy"."tenant_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."team_member_locations" ADD CONSTRAINT "team_member_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_member_locations_location_idx" ON "tenancy"."team_member_locations" USING btree ("location_id");
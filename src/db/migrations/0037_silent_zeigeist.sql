CREATE TABLE "tenancy"."team_locations" (
	"team_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "team_locations_uq" UNIQUE("team_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "tenancy"."team_locations" ADD CONSTRAINT "team_locations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "tenancy"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy"."team_locations" ADD CONSTRAINT "team_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "geo"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_locations_location_idx" ON "tenancy"."team_locations" USING btree ("location_id");
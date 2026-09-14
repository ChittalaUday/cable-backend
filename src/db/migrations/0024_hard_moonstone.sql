ALTER TABLE "crm"."service_coverage" DROP CONSTRAINT "service_coverage_uq";--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD COLUMN "package_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "crm"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_coverage_tenant_package_idx" ON "crm"."service_coverage" USING btree ("tenant_id","package_id");--> statement-breakpoint
ALTER TABLE "crm"."service_coverage" ADD CONSTRAINT "service_coverage_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","service_id","service_provider_id","package_id","location_id");
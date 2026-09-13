TRUNCATE TABLE "crm"."account_transactions";--> statement-breakpoint
ALTER TABLE "crm"."account_transactions" ADD COLUMN "service_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."account_transactions" ADD CONSTRAINT "account_transactions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "crm"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_tx_tenant_service_idx" ON "crm"."account_transactions" USING btree ("tenant_id","service_id");
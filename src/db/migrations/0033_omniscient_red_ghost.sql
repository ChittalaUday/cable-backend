-- pg_trgm is what makes `ILIKE '%term%'` indexable at all.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
DROP INDEX "crm"."customers_tenant_name_idx";--> statement-breakpoint
DROP INDEX "crm"."customers_tenant_phone_idx";--> statement-breakpoint
CREATE INDEX "users_name_trgm_idx" ON "auth"."users" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_phone_trgm_idx" ON "auth"."users" USING gin ("phone" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_name_trgm_idx" ON "crm"."customers" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_phone_trgm_idx" ON "crm"."customers" USING gin ("phone" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_code_trgm_idx" ON "crm"."customers" USING gin ("customer_code" gin_trgm_ops);
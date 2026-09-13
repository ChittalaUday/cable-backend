ALTER TABLE "crm"."customers" DROP CONSTRAINT "customers_customer_code_unique";--> statement-breakpoint
ALTER TABLE "crm"."customers" ALTER COLUMN "customer_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."users" ADD COLUMN "customer_code" text;--> statement-breakpoint
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_customer_code_unique" UNIQUE("customer_code");
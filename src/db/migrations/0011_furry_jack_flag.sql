ALTER TABLE "crm"."customers" DROP CONSTRAINT "customers_phone_ten_digits";--> statement-breakpoint
ALTER TABLE "crm"."customers" DROP CONSTRAINT "customers_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "crm"."customers_tenant_phone_idx";--> statement-breakpoint
ALTER TABLE "crm"."customers" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."customers" ADD CONSTRAINT "customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_user_idx" ON "crm"."customers" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "crm"."customers" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "crm"."customers" DROP COLUMN "phone";--> statement-breakpoint
ALTER TABLE "crm"."customers" DROP COLUMN "email";
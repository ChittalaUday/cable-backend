DROP INDEX "crm"."channels_tenant_lang_idx";--> statement-breakpoint
ALTER TABLE "crm"."channels" ADD COLUMN "languages" text[] DEFAULT ARRAY['Telugu']::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "channels_languages_idx" ON "crm"."channels" USING gin ("languages");--> statement-breakpoint
ALTER TABLE "crm"."channels" DROP COLUMN "language";
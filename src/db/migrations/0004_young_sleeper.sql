CREATE TABLE "auth"."otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"purpose" text DEFAULT 'login' NOT NULL,
	"channel" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "otp_codes_identifier_idx" ON "auth"."otp_codes" USING btree ("identifier","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "otp_codes_expires_at_idx" ON "auth"."otp_codes" USING btree ("expires_at");
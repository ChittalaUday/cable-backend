CREATE TABLE "remotes"."remote_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remote_id" uuid,
	"button_name" text NOT NULL,
	"button_key" text NOT NULL,
	"protocol" text NOT NULL,
	"address" text NOT NULL,
	"command" text NOT NULL,
	"command_number" integer NOT NULL,
	"raw_data" text NOT NULL,
	"bits" integer NOT NULL,
	"bit_order" text NOT NULL,
	"repeat" boolean DEFAULT false NOT NULL,
	"raw_timings" jsonb NOT NULL,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_captures_remote_btn_uq" UNIQUE("remote_id","button_name")
);
--> statement-breakpoint
ALTER TABLE "remotes"."remote_captures" ADD CONSTRAINT "remote_captures_remote_id_remotes_id_fk" FOREIGN KEY ("remote_id") REFERENCES "remotes"."remotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remote_captures_remote_idx" ON "remotes"."remote_captures" USING btree ("remote_id");--> statement-breakpoint
CREATE INDEX "remote_captures_btn_key_idx" ON "remotes"."remote_captures" USING btree ("button_key");
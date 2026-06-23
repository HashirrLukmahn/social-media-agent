CREATE TABLE "follows" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"handle" text NOT NULL,
	"followed_at" timestamp NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "takedown_log" (
	"id" text PRIMARY KEY NOT NULL,
	"uri" text,
	"caption" text,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_records" ADD COLUMN IF NOT EXISTS "template_used" text;
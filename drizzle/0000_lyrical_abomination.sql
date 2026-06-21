CREATE TABLE "post_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"checkpoint" text NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"reposts" integer DEFAULT 0 NOT NULL,
	"replies" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"follower_delta" integer DEFAULT 0 NOT NULL,
	"sentiment_adjusted_replies" real,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_records" (
	"slot_id" text PRIMARY KEY NOT NULL,
	"niche" text NOT NULL,
	"topic" text NOT NULL,
	"image_url" text NOT NULL,
	"caption" text NOT NULL,
	"status" text NOT NULL,
	"bluesky_uri" text,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"posted_at" timestamp,
	"score" real
);
--> statement-breakpoint
CREATE TABLE "run_log" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text,
	"agent_name" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"slot_id" text NOT NULL,
	"checkpoint" text NOT NULL,
	"correlation_id" text NOT NULL,
	"bluesky_uri" text NOT NULL,
	"fire_at" timestamp NOT NULL,
	"fired_at" timestamp,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "style_log_history" (
	"id" text PRIMARY KEY NOT NULL,
	"niche" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_id_post_records_slot_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post_records"("slot_id") ON DELETE no action ON UPDATE no action;
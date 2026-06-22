import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  jsonb,
} from "drizzle-orm/pg-core";


export const postRecords = pgTable("post_records", {
  slotId: text("slot_id").primaryKey(),
  niche: text("niche").notNull(),
  topic: text("topic").notNull(),
  // Memegen template id (or "fallback"/"magichour") used for this post. Nullable for
  // rows written before this column existed. Read back to avoid repeating formats.
  templateUsed: text("template_used"),
  imageUrl: text("image_url").notNull(),
  caption: text("caption").notNull(),
  status: text("status").notNull(), // 'generated' | 'posted' | 'skipped'
  blueskyUri: text("bluesky_uri"),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  postedAt: timestamp("posted_at"),
  score: real("score"), // null until final scoring after +24hr checkpoint
});

export const postMetrics = pgTable("post_metrics", {
  id: text("id").primaryKey(), // `${slotId}:${checkpoint}`
  postId: text("post_id")
    .notNull()
    .references(() => postRecords.slotId),
  checkpoint: text("checkpoint").notNull(), // '1hr' | '6hr' | '24hr'
  likes: integer("likes").notNull().default(0),
  reposts: integer("reposts").notNull().default(0),
  replies: integer("replies").notNull().default(0),
  views: integer("views").notNull().default(0),
  followerDelta: integer("follower_delta").notNull().default(0),
  sentimentAdjustedReplies: real("sentiment_adjusted_replies"),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
});

export const runLog = pgTable("run_log", {
  id: text("id").primaryKey(), // uuid
  correlationId: text("correlation_id"),
  agentName: text("agent_name").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull(), // 'success' | 'failed' | 'skipped' | 'circuit-open'
  durationMs: integer("duration_ms"),
  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
});

export const styleLogHistory = pgTable("style_log_history", {
  id: text("id").primaryKey(), // uuid
  niche: text("niche").notNull(),
  snapshot: jsonb("snapshot").notNull(), // full StyleLog object
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const scheduledJobs = pgTable("scheduled_jobs", {
  id: text("id").primaryKey(), // `${slotId}:${checkpoint}`
  slotId: text("slot_id").notNull(),
  checkpoint: text("checkpoint").notNull(), // '1hr' | '6hr' | '24hr'
  correlationId: text("correlation_id").notNull(),
  blueskyUri: text("bluesky_uri").notNull(),
  fireAt: timestamp("fire_at").notNull(),
  firedAt: timestamp("fired_at"),
  status: text("status").notNull().default("pending"), // 'pending' | 'fired' | 'failed'
});

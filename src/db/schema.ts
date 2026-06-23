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
  // Which generation path produced this post: 'memegen' | 'magichour' | 'fallback'.
  // Nullable for rows written before this column existed. Read back by the daily
  // posting-plan analysis to compare generator performance.
  generator: text("generator"),
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

// Accounts the bot has followed during the per-cycle growth pass (Feature 1).
// One row per follow. The daily 20-follow cap is enforced separately in Redis
// (follows_today); this table is the durable record of who we've followed so we
// never follow the same account twice.
export const follows = pgTable("follows", {
  id: text("id").primaryKey(), // uuid
  did: text("did").notNull(), // the followed account's DID
  handle: text("handle").notNull(), // their handle at time of follow
  followedAt: timestamp("followed_at").notNull(),
  source: text("source").notNull(), // which niche hashtag surfaced them
});

// Content the safety-review system has FLAGGED (§6). The growth pass cross-references
// like-candidate posts against this log so the bot never likes content (by URI) that
// the safety system has flagged. Populated by safetyReview.ts on the FLAGGED path.
export const takedownLog = pgTable("takedown_log", {
  id: text("id").primaryKey(), // uuid
  uri: text("uri"), // external post URI if applicable (null for our own pre-post flags)
  caption: text("caption"), // the flagged caption/content
  reason: text("reason").notNull(), // why it was flagged
  source: text("source").notNull(), // 'safety-review'
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

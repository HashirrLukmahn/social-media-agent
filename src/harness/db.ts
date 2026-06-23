// Drizzle client and typed query helpers for Postgres.
//
// These functions are intentionally raw (no harnessedCall wrapper here) so
// agents can wrap them in harnessedCall with their own agentName/action context.
// The logger is the exception — it calls insertRunLogEntry directly to avoid
// a circular dependency with harnessedCall.

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq, desc, gte, lte, and } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../db/schema.js";
import type { StyleLog } from "../shared/types.js";

let db: PostgresJsDatabase<typeof schema> | null = null;

function getDb(): PostgresJsDatabase<typeof schema> {
  if (db) return db;

  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set — Railway Postgres must be provisioned");
  }

  const sql = postgres(url, { max: 10 });
  db = drizzle(sql, { schema });
  return db;
}

// Exposed for unit tests to reset singleton state between test cases.
export function _resetDbForTesting(): void {
  db = null;
}

export async function insertPostRecord(
  record: typeof schema.postRecords.$inferInsert
): Promise<void> {
  await getDb().insert(schema.postRecords).values(record);
}

export async function updatePostRecord(
  slotId: string,
  updates: Partial<typeof schema.postRecords.$inferInsert>
): Promise<void> {
  await getDb()
    .update(schema.postRecords)
    .set(updates)
    .where(eq(schema.postRecords.slotId, slotId));
}

export async function insertPostMetrics(
  metrics: typeof schema.postMetrics.$inferInsert
): Promise<void> {
  await getDb().insert(schema.postMetrics).values(metrics);
}

export async function setPostScore(slotId: string, score: number): Promise<void> {
  await getDb()
    .update(schema.postRecords)
    .set({ score })
    .where(eq(schema.postRecords.slotId, slotId));
}

export async function insertRunLogEntry(
  entry: typeof schema.runLog.$inferInsert
): Promise<void> {
  await getDb().insert(schema.runLog).values(entry);
}

export async function getRecentRunLog(
  limit = 100
): Promise<(typeof schema.runLog.$inferSelect)[]> {
  return getDb()
    .select()
    .from(schema.runLog)
    .orderBy(desc(schema.runLog.timestamp))
    .limit(limit);
}

export async function getRunLogForCorrelation(
  correlationId: string
): Promise<(typeof schema.runLog.$inferSelect)[]> {
  return getDb()
    .select()
    .from(schema.runLog)
    .where(eq(schema.runLog.correlationId, correlationId))
    .orderBy(schema.runLog.timestamp);
}

export async function insertStyleLogHistory(
  niche: string,
  id: string,
  snapshot: StyleLog
): Promise<void> {
  await getDb()
    .insert(schema.styleLogHistory)
    .values({ id, niche, snapshot: snapshot as unknown as Record<string, unknown> });
}

export async function getLatestStyleLogHistory(
  niche: string
): Promise<typeof schema.styleLogHistory.$inferSelect | null> {
  const rows = await getDb()
    .select()
    .from(schema.styleLogHistory)
    .where(eq(schema.styleLogHistory.niche, niche))
    .orderBy(desc(schema.styleLogHistory.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getRecentPostRecords(
  niche: string,
  daysBack = 14
): Promise<(typeof schema.postRecords.$inferSelect)[]> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  return getDb()
    .select()
    .from(schema.postRecords)
    .where(
      and(
        eq(schema.postRecords.niche, niche),
        gte(schema.postRecords.generatedAt, since)
      )
    )
    .orderBy(desc(schema.postRecords.generatedAt));
}

// Distinct templates used by the most recent posts, newest first. Powers the
// meme generator's "don't repeat the last few formats" guard. Skips null templates
// (rows written before the column existed) and dedupes while preserving recency.
export async function getRecentTemplates(
  niche: string,
  limit = 8
): Promise<string[]> {
  const rows = await getDb()
    .select({ templateUsed: schema.postRecords.templateUsed })
    .from(schema.postRecords)
    .where(eq(schema.postRecords.niche, niche))
    .orderBy(desc(schema.postRecords.generatedAt))
    .limit(limit);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const t = r.templateUsed;
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export async function getPostMetricsForRecord(
  slotId: string
): Promise<(typeof schema.postMetrics.$inferSelect)[]> {
  return getDb()
    .select()
    .from(schema.postMetrics)
    .where(eq(schema.postMetrics.postId, slotId))
    .orderBy(schema.postMetrics.recordedAt);
}

export async function getPostRecord(
  slotId: string
): Promise<typeof schema.postRecords.$inferSelect | null> {
  const rows = await getDb()
    .select()
    .from(schema.postRecords)
    .where(eq(schema.postRecords.slotId, slotId))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertScheduledJob(
  job: typeof schema.scheduledJobs.$inferInsert
): Promise<void> {
  await getDb()
    .insert(schema.scheduledJobs)
    .values(job)
    .onConflictDoNothing();
}

export async function getDueScheduledJobs(): Promise<(typeof schema.scheduledJobs.$inferSelect)[]> {
  return getDb()
    .select()
    .from(schema.scheduledJobs)
    .where(
      and(
        eq(schema.scheduledJobs.status, "pending"),
        lte(schema.scheduledJobs.fireAt, new Date())
      )
    );
}

export async function markScheduledJobFired(id: string): Promise<void> {
  await getDb()
    .update(schema.scheduledJobs)
    .set({ firedAt: new Date(), status: "fired" })
    .where(eq(schema.scheduledJobs.id, id));
}

export async function markScheduledJobFailed(id: string): Promise<void> {
  await getDb()
    .update(schema.scheduledJobs)
    .set({ status: "failed" })
    .where(eq(schema.scheduledJobs.id, id));
}

// ── Follows (Feature 1) ──────────────────────────────────────────────────────

export async function insertFollow(
  record: typeof schema.follows.$inferInsert
): Promise<void> {
  await getDb().insert(schema.follows).values(record);
}

// All DIDs the bot has ever followed — used to skip accounts we already follow.
export async function getFollowedDids(): Promise<Set<string>> {
  const rows = await getDb()
    .select({ did: schema.follows.did })
    .from(schema.follows);
  return new Set(rows.map((r) => r.did));
}

// ── Takedown log (Feature 2 cross-reference) ─────────────────────────────────

export async function insertTakedown(
  record: typeof schema.takedownLog.$inferInsert
): Promise<void> {
  await getDb().insert(schema.takedownLog).values(record);
}

// All non-null post URIs the safety system has flagged — used to skip liking
// content that's already been taken down.
export async function getTakedownUris(): Promise<Set<string>> {
  const rows = await getDb()
    .select({ uri: schema.takedownLog.uri })
    .from(schema.takedownLog);
  const out = new Set<string>();
  for (const r of rows) {
    if (r.uri) out.add(r.uri);
  }
  return out;
}

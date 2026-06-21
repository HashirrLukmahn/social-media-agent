// Daily refresh job: reads Postgres, writes Redis TTL'd cache for today.
// Runs once per day, called by OpenClaw's always-on loop at day boundary.
// §3.3 of spec.

import { kvSet } from "../harness/store.js";
import { getLatestStyleLogHistory, getRecentPostRecords } from "../harness/db.js";
import { synthesizeStrategy } from "../modules/analytics.js";
import { fetchTrendingThemes } from "../modules/trendingThemes.js";
import { fetchCurrentEvents } from "../modules/currentEvents.js";
import type { GenerationCap, StyleLog, StyleLogTopic } from "./types.js";
import {
  NICHE,
  MANDATORY_GENERATIONS,
  EXPLORATORY_GENERATIONS,
} from "./constants.js";
import { SEED_TOPICS } from "./config.js";

const STYLE_LOG_KEY = "style_log:today";
const GENERATION_CAP_KEY = "generation_cap:today";
const TTL_SECONDS = 24 * 60 * 60; // 24hr

export async function runDailyRefresh(): Promise<void> {
  console.info("[daily-refresh] starting daily refresh...");

  await refreshStyleLog();
  await refreshGenerationCap();
  await refreshStrategy();
  await refreshTrendingThemes();
  await refreshCurrentEvents();

  console.info("[daily-refresh] daily refresh complete");
}

async function refreshStyleLog(): Promise<void> {
  const latest = await getLatestStyleLogHistory(NICHE);

  let snapshot: StyleLog;
  if (latest) {
    snapshot = latest.snapshot as unknown as StyleLog;
    // Backfill fields for logs written before they existed.
    if (snapshot.audienceNotes === undefined) {
      snapshot = { ...snapshot, audienceNotes: "" };
    }
    if (snapshot.trendingThemes === undefined) {
      snapshot = { ...snapshot, trendingThemes: [] };
    }
    if (snapshot.currentEventsContext === undefined) {
      snapshot = { ...snapshot, currentEventsContext: [] };
    }
    if (snapshot.publicSentimentTowardDevs === undefined) {
      snapshot = { ...snapshot, publicSentimentTowardDevs: null };
    }
  } else {
    snapshot = {
      niche: NICHE,
      topics: [],
      formatNotes: [],
      audienceNotes: "",
      trendingThemes: [],
      currentEventsContext: [],
      publicSentimentTowardDevs: null,
      lastUpdated: new Date().toISOString(),
    };
    console.warn("[daily-refresh] no style log history found — using empty seed");
  }

  snapshot = mergeSeedTopics(snapshot);

  await kvSet(STYLE_LOG_KEY, snapshot, TTL_SECONDS);
  console.info(`[daily-refresh] style_log:today written (${snapshot.topics.length} topics)`);
}

// Ensure every configured SEED_TOPIC is present in the style log so the bot covers
// them from day one. Existing topics (with their learned scores) are preserved; only
// missing seeds are appended as low-confidence "exploring" candidates, which the
// analytics loop then promotes or demotes based on real engagement.
function mergeSeedTopics(snapshot: StyleLog): StyleLog {
  if (SEED_TOPICS.length === 0) return snapshot;
  const existing = new Set(snapshot.topics.map((t) => t.name.toLowerCase()));
  const now = new Date().toISOString();
  const seeded: StyleLogTopic[] = SEED_TOPICS.filter(
    (name) => !existing.has(name.toLowerCase())
  ).map((name) => ({
    name,
    timesGenerated: 0,
    avgScore: 0,
    confidence: "exploring",
    lastUsed: now,
  }));
  return seeded.length > 0 ? { ...snapshot, topics: [...snapshot.topics, ...seeded] } : snapshot;
}

async function refreshStrategy(): Promise<void> {
  const current = await import("../harness/store.js")
    .then(({ kvGet }) => kvGet<StyleLog>(STYLE_LOG_KEY));
  if (!current) return;

  let updated: StyleLog;
  try {
    const { formatNotes, audienceNotes } = await synthesizeStrategy(current);
    updated = { ...current, formatNotes, audienceNotes, lastUpdated: new Date().toISOString() };
  } catch (err) {
    // Strategy synthesis is best-effort — a model failure must not block the refresh.
    console.warn("[daily-refresh] strategy synthesis failed, keeping existing notes:", err instanceof Error ? err.message : err);
    return;
  }

  await kvSet(STYLE_LOG_KEY, updated, TTL_SECONDS);
  console.info(`[daily-refresh] strategy notes updated — ${updated.formatNotes.length} format notes`);
}

// §3.7 step 1 — scrape reference accounts and write abstracted trending themes onto
// style_log:today. fetchTrendingThemes() never throws (returns [] on empty config or
// any failure), so this can only no-op, never block the rest of the refresh.
async function refreshTrendingThemes(): Promise<void> {
  const current = await import("../harness/store.js")
    .then(({ kvGet }) => kvGet<StyleLog>(STYLE_LOG_KEY));
  if (!current) return;

  const trendingThemes = await fetchTrendingThemes();
  const updated: StyleLog = { ...current, trendingThemes, lastUpdated: new Date().toISOString() };

  await kvSet(STYLE_LOG_KEY, updated, TTL_SECONDS);
  console.info(`[daily-refresh] trending themes updated — ${trendingThemes.length} themes`);
}

// §3.7 step 2 — one Claude web-search call for today's tech/cultural context, written
// onto style_log:today. fetchCurrentEvents() never throws (returns [] on any failure),
// so this can only no-op, never block the rest of the refresh.
async function refreshCurrentEvents(): Promise<void> {
  const current = await import("../harness/store.js")
    .then(({ kvGet }) => kvGet<StyleLog>(STYLE_LOG_KEY));
  if (!current) return;

  const { currentEventsContext, publicSentimentTowardDevs } = await fetchCurrentEvents();
  const updated: StyleLog = {
    ...current,
    currentEventsContext,
    publicSentimentTowardDevs,
    lastUpdated: new Date().toISOString(),
  };

  await kvSet(STYLE_LOG_KEY, updated, TTL_SECONDS);
  console.info(
    `[daily-refresh] current events updated — ${currentEventsContext.length} bullets, sentiment=${publicSentimentTowardDevs?.tone ?? "none"}`
  );
}

async function refreshGenerationCap(): Promise<void> {
  // Count yesterday's generations for logging only — today's cap always resets.
  const recentRecords = await getRecentPostRecords(NICHE, 1);
  const generatedYesterday = recentRecords.filter(
    (r) => r.generatedAt > new Date(Date.now() - 24 * 60 * 60 * 1000)
  ).length;

  const cap: GenerationCap = {
    date: new Date().toISOString().split("T")[0] ?? new Date().toISOString().slice(0, 10),
    mandatory: MANDATORY_GENERATIONS,
    exploratory: EXPLORATORY_GENERATIONS,
    used: 0,
  };

  await kvSet(GENERATION_CAP_KEY, cap, TTL_SECONDS);
  console.info(
    `[daily-refresh] generation_cap:today written (max=${cap.mandatory + cap.exploratory}, yesterday posts=${generatedYesterday})`
  );
}

// Daily refresh job: reads Postgres, writes Redis TTL'd cache for today.
// Runs once per day, called by OpenClaw's always-on loop at day boundary.
// §3.3 of spec.

import { kvSet } from "../harness/store.js";
import { getLatestStyleLogHistory, getRecentPostRecords } from "../harness/db.js";
import { synthesizeStrategy } from "../modules/analytics.js";
import type { CreditBudget, StyleLog } from "./types.js";
import {
  NICHE,
  DAILY_CREDIT_LIMIT,
  CREDIT_SCHEDULED_POSTS,
  CREDIT_EXPLORATION_BUDGET,
} from "./constants.js";

const STYLE_LOG_KEY = "style_log:today";
const CREDIT_BUDGET_KEY = "credit_budget:today";
const TTL_SECONDS = 24 * 60 * 60; // 24hr

export async function runDailyRefresh(): Promise<void> {
  console.info("[daily-refresh] starting daily refresh...");

  await refreshStyleLog();
  await refreshCreditBudget();
  await refreshStrategy();

  console.info("[daily-refresh] daily refresh complete");
}

async function refreshStyleLog(): Promise<void> {
  const latest = await getLatestStyleLogHistory(NICHE);

  let snapshot: StyleLog;
  if (latest) {
    snapshot = latest.snapshot as unknown as StyleLog;
    // Backfill audienceNotes for logs written before this field existed.
    if (snapshot.audienceNotes === undefined) {
      snapshot = { ...snapshot, audienceNotes: "" };
    }
  } else {
    snapshot = {
      niche: NICHE,
      topics: [],
      formatNotes: [],
      audienceNotes: "",
      lastUpdated: new Date().toISOString(),
    };
    console.warn("[daily-refresh] no style log history found — using empty seed");
  }

  await kvSet(STYLE_LOG_KEY, snapshot, TTL_SECONDS);
  console.info(`[daily-refresh] style_log:today written (${snapshot.topics.length} topics)`);
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
    // Strategy synthesis is best-effort — a Gemini failure must not block the refresh.
    console.warn("[daily-refresh] strategy synthesis failed, keeping existing notes:", err instanceof Error ? err.message : err);
    return;
  }

  await kvSet(STYLE_LOG_KEY, updated, TTL_SECONDS);
  console.info(`[daily-refresh] strategy notes updated — ${updated.formatNotes.length} format notes`);
}

async function refreshCreditBudget(): Promise<void> {
  // Query recent posts to determine how many credits were spent yesterday
  // (for logging purposes — today's budget always resets to the default split).
  const recentRecords = await getRecentPostRecords(NICHE, 1);
  const generatedYesterday = recentRecords.filter(
    (r) => r.generatedAt > new Date(Date.now() - 24 * 60 * 60 * 1000)
  ).length;

  const buffer = DAILY_CREDIT_LIMIT - CREDIT_SCHEDULED_POSTS - CREDIT_EXPLORATION_BUDGET;
  const budget: CreditBudget = {
    date: new Date().toISOString().split("T")[0] ?? new Date().toISOString().slice(0, 10),
    totalAllotted: DAILY_CREDIT_LIMIT,
    scheduledPosts: CREDIT_SCHEDULED_POSTS,
    exploration: CREDIT_EXPLORATION_BUDGET,
    buffer,
    spent: 0,
    remaining: DAILY_CREDIT_LIMIT,
  };

  await kvSet(CREDIT_BUDGET_KEY, budget, TTL_SECONDS);
  console.info(
    `[daily-refresh] credit_budget:today written (total=${budget.totalAllotted}, yesterday posts=${generatedYesterday})`
  );
}

// Single scheduler — owns the clock loop, daily refresh, slot dispatch, and
// engagement poll firing. Replaces OpenClaw and the Social Media Agent's timing loop.

import { v4 as uuidv4 } from "uuid";
import { isPaused } from "./harness/index.js";
import { kvGet, kvSet } from "./harness/store.js";
import { log } from "./harness/logger.js";
import {
  getDueScheduledJobs,
  markScheduledJobFired,
  markScheduledJobFailed,
  insertPostMetrics,
  getPostRecord,
} from "./harness/db.js";
import { runDailyRefresh } from "./shared/dailyRefresh.js";
import { runSafetyChain } from "./modules/safetyReview.js";
import { postMemeToSlot, pollEngagement } from "./modules/socialMedia.js";
import { processMetrics } from "./modules/analytics.js";
import { POSTING_WINDOWS } from "./shared/constants.js";
import type { PostingSlot } from "./shared/types.js";

const CLOCK_CHECK_INTERVAL_MS = 30_000;
const PRE_PING_MS = 5 * 60_000;
const POST_LATE_GRACE_MS = 10 * 60_000; // fire up to 10 min after window opens if we missed the pre-ping
const LAST_REFRESH_DAY_KEY = "last_refresh_day";

function randomTimeInWindow(
  openH: number,
  openM: number,
  closeH: number,
  closeM: number,
  baseDate: Date
): Date {
  const openMs = (openH * 60 + openM) * 60_000;
  let closeMs = (closeH * 60 + closeM) * 60_000;
  if (closeMs <= openMs) closeMs += 24 * 60 * 60_000; // window spans midnight UTC

  const windowMs = closeMs - openMs;
  const offsetMs = Math.floor(Math.random() * windowMs);

  const dayStartUtc = new Date(
    Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate())
  );
  return new Date(dayStartUtc.getTime() + openMs + offsetMs);
}

function buildTodaySchedule(): PostingSlot[] {
  const today = new Date();
  return POSTING_WINDOWS.map((w, i) => {
    const scheduledAt = randomTimeInWindow(w.openH, w.openM, w.closeH, w.closeM, today);
    const windowIndex = i as 0 | 1 | 2;
    const dateStr = today.toISOString().slice(0, 10);
    const slotId = `${dateStr}:w${windowIndex}`;
    return {
      slotId,
      windowIndex,
      scheduledAt,
      correlationId: uuidv4(),
    };
  });
}

// Uses a persistent Redis key so the refresh survives process restarts correctly.
// An in-process variable fires twice on same-day restart and misses the boundary
// if the process never restarts that day.
async function maybeRunDailyRefresh(): Promise<void> {
  const currentDay = new Date().toISOString().slice(0, 10);
  const lastRefreshDay = await kvGet<string>(LAST_REFRESH_DAY_KEY);
  if (lastRefreshDay === currentDay) return;

  try {
    await runDailyRefresh();
    await kvSet(LAST_REFRESH_DAY_KEY, currentDay); // no TTL — persistent key
    console.info(`[scheduler] daily refresh complete for ${currentDay}`);
  } catch (err) {
    console.error("[scheduler] daily refresh failed:", err instanceof Error ? err.message : err);
  }
}

async function runFullPostingCycle(slot: PostingSlot): Promise<void> {
  const { slotId, correlationId } = slot;
  console.info(`[scheduler] running posting cycle for slot ${slotId} corr=${correlationId}`);

  try {
    const meme = await runSafetyChain(slotId, correlationId);
    await postMemeToSlot(slotId, meme, correlationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] posting cycle failed for ${slotId}: ${message}`);
    await log({
      agentName: "orchestrator",
      action: "skip-slot",
      status: "skipped",
      correlationId,
      input: { slotId },
      error: message,
    });
  }
}

async function fireDueJobs(): Promise<void> {
  let dueJobs;
  try {
    dueJobs = await getDueScheduledJobs();
  } catch (err) {
    console.error("[scheduler] failed to fetch due jobs:", err instanceof Error ? err.message : err);
    return;
  }

  for (const job of dueJobs) {
    const checkpoint = job.checkpoint as "1hr" | "6hr" | "24hr";
    const { slotId, blueskyUri, correlationId, id } = job;

    try {
      const metrics = await pollEngagement(blueskyUri, slotId, checkpoint, correlationId);
      await insertPostMetrics({
        id: `${slotId}:${checkpoint}`,
        postId: slotId,
        checkpoint,
        likes: metrics.likes,
        reposts: metrics.reposts,
        replies: metrics.replies,
        views: metrics.views,
        followerDelta: metrics.followerDelta,
        sentimentAdjustedReplies: null,
      });

      const record = await getPostRecord(slotId);
      const topic = record?.topic ?? "unknown";
      await processMetrics(metrics, topic, correlationId);
      await markScheduledJobFired(id);
    } catch (err) {
      console.error(
        `[scheduler] job ${id} (${slotId}:${checkpoint}) failed:`,
        err instanceof Error ? err.message : err
      );
      await markScheduledJobFailed(id).catch(() => {});
    }
  }
}

export async function startScheduler(): Promise<never> {
  console.info("[scheduler] starting...");
  await maybeRunDailyRefresh();

  let todaySchedule = buildTodaySchedule();
  const firedSlots = new Set<string>();

  console.info(
    `[scheduler] today's slots: ${todaySchedule.map((s) => `${s.slotId}@${s.scheduledAt.toISOString()}`).join(", ")}`
  );

  setInterval(async () => {
    try {
      if (await isPaused()) return;

      const now = new Date();
      const currentDay = now.toISOString().slice(0, 10);

      // Rebuild schedule at day boundary
      if (currentDay !== todaySchedule[0]?.slotId.slice(0, 10)) {
        await maybeRunDailyRefresh();
        todaySchedule = buildTodaySchedule();
        firedSlots.clear();
        console.info(
          `[scheduler] new day ${currentDay}, rebuilt schedule: ${todaySchedule.map((s) => `${s.slotId}@${s.scheduledAt.toISOString()}`).join(", ")}`
        );
      }

      // Fire any Postgres-backed engagement poll jobs that are now due
      await fireDueJobs();

      // Check posting windows — fire the full cycle once we enter the pre-ping window
      for (const slot of todaySchedule) {
        if (firedSlots.has(slot.slotId)) continue;

        const msToSlot = slot.scheduledAt.getTime() - now.getTime();
        // Window: from PRE_PING_MS before the slot to POST_LATE_GRACE_MS after it.
        // The grace period handles restarts that miss the exact pre-ping moment.
        if (msToSlot <= PRE_PING_MS && msToSlot > -POST_LATE_GRACE_MS) {
          firedSlots.add(slot.slotId);
          runFullPostingCycle(slot).catch((err) => {
            console.error(`[scheduler] runFullPostingCycle threw for ${slot.slotId}:`, err);
          });
        }
      }
    } catch (err) {
      console.error("[scheduler] tick error:", err instanceof Error ? err.message : err);
    }
  }, CLOCK_CHECK_INTERVAL_MS);

  // Hold the process open indefinitely.
  await new Promise<never>(() => undefined);
  return undefined as never;
}

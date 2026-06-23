// Analytics module
// Responsibility: turn engagement data into the next generation's direction.
// Owns the explore/exploit learning loop and the daily generation cap.

import { harnessedCall } from "../harness/index.js";
import { completeText } from "../shared/llm.js";
import { recallLearnings, addLearning } from "../shared/mem0.js";
import { kvGet, kvSet } from "../harness/store.js";
import {
  setPostScore,
  insertStyleLogHistory,
  getRecentPostRecords,
} from "../harness/db.js";
import { v4 as uuidv4 } from "uuid";
import type { RawEngagementMetrics, StyleLog, StyleLogTopic } from "../shared/types.js";
import {
  getPostingPlan,
  savePostingPlan,
  validatePlan,
  planTotalPosts,
  countByGenerator,
} from "../shared/postingPlan.js";
import {
  NICHE,
  SCORE_WEIGHTS,
  EMERGING_MIN_POSTS,
  ESTABLISHED_MIN_POSTS,
  POSTING_WINDOWS,
  POSTING_PLAN_MIN_POSTS,
  POSTING_PLAN_MAX_POSTS,
  POSTING_PLAN_MAX_PER_WINDOW,
  POSTING_PLAN_MIN_SCORED,
  MAGICHOUR_MAX_PER_DAY,
} from "../shared/constants.js";

const STYLE_LOG_KEY = "style_log:today";

async function scoreSentiment(
  replies: string[],
  correlationId?: string
): Promise<number> {
  if (replies.length === 0) return 0;

  return harnessedCall(
    {
      agentName: "analytics",
      action: "sentiment-analysis",
      input: { replyCount: replies.length },
      correlationId,
      skipCircuitBreaker: true, // read-only, safe to fail open
    },
    async () => {
      const text = await completeText({
        system: `You are analyzing replies to a software engineering meme on Bluesky.
Rate the overall sentiment of these replies on a scale from -1.0 (very negative, meme didn't land)
to 1.0 (very positive, meme resonated well). Return only a JSON object: { "score": <number> }`,
        user: `Replies:\n${replies.slice(0, 20).map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
        maxTokens: 64,
      });

      const match = text.match(/"score"\s*:\s*(-?\d+(?:\.\d+)?)/);
      const score = match ? parseFloat(match[1] ?? "0") : 0;
      return Math.max(-1, Math.min(1, score));
    }
  );
}

// §4.1 scoring formula — tunable weights in constants.ts
export function computeScore(
  reposts: number,
  likes: number,
  sentimentAdjustedReplies: number
): number {
  return (
    reposts * SCORE_WEIGHTS.repost +
    likes * SCORE_WEIGHTS.like +
    sentimentAdjustedReplies * SCORE_WEIGHTS.sentimentAdjustedReply
  );
}

async function updateStyleLog(
  topic: string,
  score: number,
  correlationId?: string
): Promise<void> {
  const current = await kvGet<StyleLog>(STYLE_LOG_KEY);
  if (!current) {
    console.warn("[analytics] style log not in Redis — can't update");
    return;
  }

  const allRecords = await getRecentPostRecords(NICHE, 90);
  const topicRecords = allRecords.filter((r) => r.topic === topic && r.score !== null);

  const timesGenerated = topicRecords.length;
  const avgScore =
    timesGenerated > 0
      ? topicRecords.reduce((sum, r) => sum + (r.score ?? 0), 0) / timesGenerated
      : score;

  let confidence: StyleLogTopic["confidence"] = "exploring";
  if (timesGenerated >= ESTABLISHED_MIN_POSTS) confidence = "established";
  else if (timesGenerated >= EMERGING_MIN_POSTS) confidence = "emerging";

  const existingIdx = current.topics.findIndex((t) => t.name === topic);
  const updatedTopic: StyleLogTopic = {
    name: topic,
    timesGenerated,
    avgScore: Math.round(avgScore * 100) / 100,
    confidence,
    lastUsed: new Date().toISOString(),
  };

  const updatedTopics = [...current.topics];
  if (existingIdx >= 0) {
    updatedTopics[existingIdx] = updatedTopic;
  } else {
    updatedTopics.push(updatedTopic);
  }

  const updatedLog: StyleLog = {
    ...current,
    topics: updatedTopics,
    lastUpdated: new Date().toISOString(),
  };

  await harnessedCall(
    {
      agentName: "analytics",
      action: "save-style-log-history",
      input: { niche: NICHE, topicCount: updatedTopics.length },
      correlationId,
    },
    () => insertStyleLogHistory(NICHE, uuidv4(), updatedLog)
  );

  // Update today's Redis cache so remaining generation slots see the updated
  // topic weights immediately (spec §3.2 Analytics write exception).
  await kvSet(STYLE_LOG_KEY, updatedLog, 24 * 60 * 60);
}

// Looks at recent scored posts and asks Claude what format and audience shifts
// the data suggests. Output overwrites formatNotes and audienceNotes in the style log.
// Called once per day from dailyRefresh — not per-post, to avoid noisy single-post signal.
export async function synthesizeStrategy(
  currentLog: StyleLog,
  correlationId?: string
): Promise<{ formatNotes: string[]; audienceNotes: string }> {
  const recentRecords = await getRecentPostRecords(NICHE, 14);
  const scoredRecords = recentRecords.filter((r) => r.score !== null);

  // Not enough signal yet — return existing notes unchanged.
  if (scoredRecords.length < 3) {
    return { formatNotes: currentLog.formatNotes, audienceNotes: currentLog.audienceNotes };
  }

  const sorted = [...scoredRecords].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = sorted.slice(0, 5);
  const bottom = sorted.slice(-3);

  const fmt = (r: typeof scoredRecords[number]): string =>
    `- topic="${r.topic}" template=${r.templateUsed ?? "?"} score=${r.score?.toFixed(2)} day=${weekday(r.generatedAt)} caption="${r.caption.slice(0, 80)}"`;
  const topLines = top.map(fmt).join("\n");
  const bottomLines = bottom.map(fmt).join("\n");

  // Format usage distribution so the model can flag over-used templates explicitly.
  const templateCounts = new Map<string, number>();
  for (const r of scoredRecords) {
    const t = r.templateUsed ?? "unknown";
    templateCounts.set(t, (templateCounts.get(t) ?? 0) + 1);
  }
  const templateUsage = [...templateCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} (${n})`)
    .join(", ");
  const currentFormatNotes = currentLog.formatNotes.length > 0
    ? currentLog.formatNotes.map((n) => `- ${n}`).join("\n")
    : "(none yet)";

  // Recall prior qualitative learnings from Mem0 (semantic, cross-cutting — e.g.
  // timing effects) to inform today's synthesis. Best-effort: never blocks.
  const priorLearnings = await recallStrategyLearnings(correlationId);
  const priorLearningsBlock = priorLearnings.length > 0
    ? priorLearnings.map((l) => `- ${l}`).join("\n")
    : "(none yet)";

  const system = `You are a content strategist for an autonomous Bluesky meme account in the software engineering space.

Analyze the engagement data in the user message (last 14 days) and provide updated content guidance.

Each post lists its meme template (template=) — factor format into your analysis, not just topic.

Provide:
1. Up to 4 specific, actionable format notes (caption style, tone, length, structure, humor type, AND which meme templates to use or avoid) derived from what's actually working in the data. If one template is over-used relative to its results, say so explicitly and suggest alternatives.
2. An updated audience description (60 words max) — be specific about what this audience responds to; use the engagement data, not generic assumptions
3. learnings: 0-3 short cross-cutting QUALITATIVE observations that don't fit a structured field — e.g. timing/day-of-week effects (note the day= field), template fatigue or which formats land, topic fatigue, recurring patterns. Each under 20 words. Only genuinely data-supported ones; use [] if none. Do not repeat the prior learnings verbatim.

Respond with ONLY valid JSON, no markdown:
{
  "formatNotes": ["...", "..."],
  "audienceNotes": "...",
  "learnings": ["...", "..."]
}`;

  const user = `TEMPLATE USAGE (last 14 days, count per template — watch for over-reliance):
${templateUsage || "(none)"}

TOP PERFORMING POSTS (highest engagement scores):
${topLines}

LOWEST PERFORMING POSTS:
${bottomLines}

CURRENT FORMAT NOTES (may be stale — update or replace based on data):
${currentFormatNotes}

CURRENT AUDIENCE NOTES: ${currentLog.audienceNotes || "(none yet)"}

PRIOR QUALITATIVE LEARNINGS (from long-term memory — use as context, don't just repeat):
${priorLearningsBlock}`;

  const result = await harnessedCall(
    {
      agentName: "analytics",
      action: "synthesize-strategy",
      input: { scoredPosts: scoredRecords.length, topTopics: top.map((r) => r.topic) },
      correlationId,
      skipCircuitBreaker: true,
    },
    async () => {
      const text = await completeText({ system, user, maxTokens: 1024 });

      // Strip markdown code fences if model wraps response despite instructions
      const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

      let parsed: { formatNotes?: unknown; audienceNotes?: unknown; learnings?: unknown };
      try {
        parsed = JSON.parse(clean) as { formatNotes?: unknown; audienceNotes?: unknown; learnings?: unknown };
      } catch {
        console.warn("[analytics] synthesize-strategy: could not parse model response, keeping existing notes");
        return { formatNotes: currentLog.formatNotes, audienceNotes: currentLog.audienceNotes, learnings: [] as string[] };
      }

      const formatNotes = Array.isArray(parsed.formatNotes)
        ? (parsed.formatNotes as unknown[]).filter((n): n is string => typeof n === "string")
        : currentLog.formatNotes;
      const audienceNotes = typeof parsed.audienceNotes === "string"
        ? parsed.audienceNotes
        : currentLog.audienceNotes;
      const learnings = Array.isArray(parsed.learnings)
        ? (parsed.learnings as unknown[]).filter((l): l is string => typeof l === "string")
        : [];

      console.info(`[analytics] strategy updated: ${formatNotes.length} format notes, ${learnings.length} new learnings, audience: "${audienceNotes.slice(0, 60)}..."`);
      return { formatNotes, audienceNotes, learnings };
    }
  );

  // Persist the new qualitative learnings into Mem0 (best-effort, alongside the
  // structured style log — §3.5). Never blocks the refresh.
  await storeStrategyLearnings(result.learnings, correlationId);

  return { formatNotes: result.formatNotes, audienceNotes: result.audienceNotes };
}

function weekday(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

// Slot ids are `${date}:w${windowIndex}:p${n}` (older rows: `${date}:w${windowIndex}`).
function parseWindowIndex(slotId: string): number | null {
  const m = slotId.match(/:w(\d+)/);
  return m && m[1] !== undefined ? parseInt(m[1], 10) : null;
}

// Daily, full-autonomy rewrite of the posting plan (the per-window generator mix).
// Compares Memegen vs Magic Hour performance and per-window performance over the last
// 14 days and asks the model to propose the next day's layout, which is then clamped
// to the constants.ts guardrails by validatePlan(). Best-effort: any failure leaves
// the current plan untouched. Called once/day from dailyRefresh.
export async function synthesizePostingPlan(correlationId?: string): Promise<void> {
  const current = await getPostingPlan();

  const records = await getRecentPostRecords(NICHE, 14);
  const scored = records.filter((r) => r.score !== null);

  // Too little signal to deviate — keep the current plan rather than thrash on noise.
  if (scored.length < POSTING_PLAN_MIN_SCORED) {
    console.info(`[analytics] posting-plan: only ${scored.length} scored posts (need ${POSTING_PLAN_MIN_SCORED}) — keeping current plan`);
    return;
  }

  // Aggregate scores by generator and by posting window.
  const genStats = new Map<string, { n: number; sum: number }>();
  const winStats = new Map<number, { n: number; sum: number }>();
  for (const r of scored) {
    const g = r.generator ?? "memegen"; // rows predating the column → treat as Memegen
    const gs = genStats.get(g) ?? { n: 0, sum: 0 };
    genStats.set(g, { n: gs.n + 1, sum: gs.sum + (r.score ?? 0) });

    const wi = parseWindowIndex(r.slotId);
    if (wi !== null) {
      const ws = winStats.get(wi) ?? { n: 0, sum: 0 };
      winStats.set(wi, { n: ws.n + 1, sum: ws.sum + (r.score ?? 0) });
    }
  }

  const genLines = [...genStats.entries()]
    .map(([g, s]) => `- ${g}: ${s.n} posts, avg score ${(s.sum / s.n).toFixed(2)}`)
    .join("\n");
  const winLines = POSTING_WINDOWS.map((_, i) => {
    const s = winStats.get(i);
    return `- window ${i}: ${s ? `${s.n} posts, avg score ${(s.sum / s.n).toFixed(2)}` : "no data yet"}`;
  }).join("\n");

  const system = `You tune the daily posting plan for an autonomous Bluesky software-engineering meme account.

There are ${POSTING_WINDOWS.length} posting windows (indexed 0..${POSTING_WINDOWS.length - 1}). Each day you decide, per window, how many posts to make and which generator each uses:
- "memegen": free template memes (Memegen.link).
- "magichour": paid generative-AI memes (limited daily balance).

Output a generatorsByWindow array with exactly ${POSTING_WINDOWS.length} inner arrays (one per window, in order). Each inner array lists the generators to post in that window (e.g. ["memegen","magichour"] = a double-up; [] = skip that window).

HARD CONSTRAINTS (a violating plan will be auto-corrected, so stay within them):
- Total posts/day: between ${POSTING_PLAN_MIN_POSTS} and ${POSTING_PLAN_MAX_POSTS}.
- At most ${POSTING_PLAN_MAX_PER_WINDOW} posts per window.
- At most ${MAGICHOUR_MAX_PER_DAY} "magichour" posts/day (cost guard).

Shift the mix toward whatever the data shows performs better (by generator AND by window), but keep some of each generator unless one is clearly and consistently worse on a real sample. Don't over-fit to a tiny sample.

Respond with ONLY valid JSON, no markdown:
{ "generatorsByWindow": [["memegen","magichour"], ["memegen"], ["memegen"]], "rationale": "<1-2 sentences>" }`;

  const user = `GENERATOR PERFORMANCE (last 14 days):
${genLines || "(none)"}

WINDOW PERFORMANCE (last 14 days):
${winLines}

CURRENT PLAN: ${JSON.stringify(current.generatorsByWindow)}
CURRENT PLAN RATIONALE: ${current.rationale}`;

  let proposed: { generatorsByWindow?: unknown; rationale?: unknown };
  try {
    proposed = await harnessedCall(
      {
        agentName: "analytics",
        action: "synthesize-posting-plan",
        input: { scoredPosts: scored.length, generators: [...genStats.keys()] },
        correlationId,
        skipCircuitBreaker: true,
      },
      async () => {
        const text = await completeText({ system, user, maxTokens: 512 });
        const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        return JSON.parse(clean) as { generatorsByWindow?: unknown; rationale?: unknown };
      }
    );
  } catch (err) {
    console.warn("[analytics] posting-plan synthesis failed — keeping current plan:", err instanceof Error ? err.message : err);
    return;
  }

  const rationale = typeof proposed.rationale === "string" ? proposed.rationale : "";
  const plan = validatePlan(proposed.generatorsByWindow, rationale);
  await savePostingPlan(plan);

  console.info(
    `[analytics] posting-plan updated → ${planTotalPosts(plan)} posts/day ` +
    `(${countByGenerator(plan, "memegen")} memegen, ${countByGenerator(plan, "magichour")} magichour): ${plan.rationale}`
  );
}

// Best-effort Mem0 recall, wrapped in the harness. Returns [] on any failure or
// when Mem0 is disabled (no MEM0_API_KEY).
async function recallStrategyLearnings(correlationId?: string): Promise<string[]> {
  try {
    return await harnessedCall(
      { agentName: "analytics", action: "mem0-recall", input: { niche: NICHE }, correlationId, skipCircuitBreaker: true },
      () => recallLearnings(`content strategy and engagement patterns for ${NICHE}`, 5)
    );
  } catch (err) {
    console.warn("[analytics] mem0 recall failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

// Best-effort Mem0 store, wrapped in the harness. Never throws.
async function storeStrategyLearnings(learnings: string[], correlationId?: string): Promise<void> {
  if (learnings.length === 0) return;
  try {
    await harnessedCall(
      { agentName: "analytics", action: "mem0-store", input: { count: learnings.length }, correlationId, skipCircuitBreaker: true },
      async () => {
        for (const learning of learnings) {
          await addLearning(learning, { source: "strategy-synthesis", niche: NICHE });
        }
      }
    );
    console.info(`[analytics] stored ${learnings.length} qualitative learnings to Mem0`);
  } catch (err) {
    console.warn("[analytics] mem0 store failed:", err instanceof Error ? err.message : err);
  }
}

export async function processMetrics(
  metrics: RawEngagementMetrics,
  topic: string,
  correlationId?: string
): Promise<void> {
  if (metrics.checkpoint !== "24hr") {
    console.info(`[analytics] checkpoint ${metrics.checkpoint} received for ${metrics.slotId} — waiting for 24hr`);
    return;
  }

  const sentimentScore = await scoreSentiment([], correlationId); // TODO: pass actual reply texts
  const sentimentAdjustedReplies = metrics.replies * ((sentimentScore + 1) / 2);
  const score = computeScore(metrics.reposts, metrics.likes, sentimentAdjustedReplies);

  await harnessedCall(
    {
      agentName: "analytics",
      action: "save-post-score",
      input: { slotId: metrics.slotId, score },
      correlationId,
    },
    () => setPostScore(metrics.slotId, score)
  );

  console.info(`[analytics] scored slot ${metrics.slotId}: ${score.toFixed(2)}`);

  await updateStyleLog(topic, score, correlationId);
}

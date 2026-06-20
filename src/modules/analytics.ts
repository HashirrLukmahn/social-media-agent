// Analytics module
// Responsibility: turn engagement data into the next generation's direction.
// Owns the explore/exploit learning loop and the credit budget.

import { GoogleGenAI } from "@google/genai";
import { harnessedCall } from "../harness/index.js";
import { kvGet, kvSet } from "../harness/store.js";
import {
  setPostScore,
  insertStyleLogHistory,
  getRecentPostRecords,
} from "../harness/db.js";
import { v4 as uuidv4 } from "uuid";
import type { RawEngagementMetrics, StyleLog, StyleLogTopic } from "../shared/types.js";
import {
  NICHE,
  SCORE_WEIGHTS,
  EMERGING_MIN_POSTS,
  ESTABLISHED_MIN_POSTS,
} from "../shared/constants.js";

const STYLE_LOG_KEY = "style_log:today";

let gemini: GoogleGenAI | null = null;

function getGemini(): GoogleGenAI {
  if (gemini) return gemini;
  gemini = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"] ?? "" });
  return gemini;
}

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
      const ai = getGemini();
      const prompt = `You are analyzing replies to a software engineering meme on Bluesky.
Rate the overall sentiment of these replies on a scale from -1.0 (very negative, meme didn't land)
to 1.0 (very positive, meme resonated well). Return only a JSON object: { "score": <number> }

Replies:
${replies.slice(0, 20).map((r, i) => `${i + 1}. ${r}`).join("\n")}`;

      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: prompt,
      });

      const text = response.text ?? "{}";
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

// Looks at recent scored posts and asks Gemini what format and audience shifts
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

  const topLines = top
    .map((r) => `- topic="${r.topic}" score=${r.score?.toFixed(2)} caption="${r.caption.slice(0, 80)}"`)
    .join("\n");
  const bottomLines = bottom
    .map((r) => `- topic="${r.topic}" score=${r.score?.toFixed(2)} caption="${r.caption.slice(0, 80)}"`)
    .join("\n");
  const currentFormatNotes = currentLog.formatNotes.length > 0
    ? currentLog.formatNotes.map((n) => `- ${n}`).join("\n")
    : "(none yet)";

  const prompt = `You are a content strategist for an autonomous Bluesky meme account in the software engineering space.

Analyze the following engagement data from the last 14 days and provide updated content guidance.

TOP PERFORMING POSTS (highest engagement scores):
${topLines}

LOWEST PERFORMING POSTS:
${bottomLines}

CURRENT FORMAT NOTES (may be stale — update or replace based on data):
${currentFormatNotes}

CURRENT AUDIENCE NOTES: ${currentLog.audienceNotes || "(none yet)"}

Provide:
1. Up to 4 specific, actionable format notes (caption style, tone, length, structure, humor type) derived from what's actually working in the data above
2. An updated audience description (60 words max) — be specific about what this audience responds to; use the engagement data, not generic assumptions

Respond with ONLY valid JSON, no markdown:
{
  "formatNotes": ["...", "..."],
  "audienceNotes": "..."
}`;

  return harnessedCall(
    {
      agentName: "analytics",
      action: "synthesize-strategy",
      input: { scoredPosts: scoredRecords.length, topTopics: top.map((r) => r.topic) },
      correlationId,
      skipCircuitBreaker: true,
    },
    async () => {
      const ai = getGemini();
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: prompt,
      });

      const text = (response.text ?? "{}").trim();
      // Strip markdown code fences if model wraps response despite instructions
      const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

      let parsed: { formatNotes?: unknown; audienceNotes?: unknown };
      try {
        parsed = JSON.parse(clean) as { formatNotes?: unknown; audienceNotes?: unknown };
      } catch {
        console.warn("[analytics] synthesize-strategy: could not parse Gemini response, keeping existing notes");
        return { formatNotes: currentLog.formatNotes, audienceNotes: currentLog.audienceNotes };
      }

      const formatNotes = Array.isArray(parsed.formatNotes)
        ? (parsed.formatNotes as unknown[]).filter((n): n is string => typeof n === "string")
        : currentLog.formatNotes;
      const audienceNotes = typeof parsed.audienceNotes === "string"
        ? parsed.audienceNotes
        : currentLog.audienceNotes;

      console.info(`[analytics] strategy updated: ${formatNotes.length} format notes, audience: "${audienceNotes.slice(0, 60)}..."`);
      return { formatNotes, audienceNotes };
    }
  );
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

// Analytics Agent
// Responsibility: turn engagement data into the next generation's direction.
// Owns the explore/exploit learning loop and the credit budget.

import { GoogleGenAI } from "@google/genai";
import { harnessedCall } from "../../harness/index.js";
import { kvGet, kvSet } from "../../harness/store.js";
import {
  setPostScore,
  insertStyleLogHistory,
  getLatestStyleLogHistory,
  getRecentPostRecords,
  getPostMetricsForRecord,
} from "../../harness/db.js";
import { v4 as uuidv4 } from "uuid";
import type { RawEngagementMetrics, StyleLog, StyleLogTopic } from "../../shared/types.js";
import {
  NICHE,
  SCORE_WEIGHTS,
  EMERGING_MIN_POSTS,
  ESTABLISHED_MIN_POSTS,
} from "../../shared/constants.js";

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

  // How many posts of this topic exist across different contexts?
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

  // Write new snapshot to Postgres history.
  await harnessedCall(
    {
      agentName: "analytics",
      action: "save-style-log-history",
      input: { niche: NICHE, topicCount: updatedTopics.length },
      correlationId,
    },
    () => insertStyleLogHistory(NICHE, uuidv4(), updatedLog)
  );

  // Also update today's Redis cache in-place so the rest of today's generation
  // sessions see the updated topic weights immediately (exception to the
  // "Redis is read-only during the day" rule — this is an Analytics write, not
  // a re-generation of the full snapshot from Postgres).
  await kvSet(STYLE_LOG_KEY, updatedLog, 24 * 60 * 60);
}

export async function processMetrics(
  metrics: RawEngagementMetrics,
  topic: string,
  correlationId?: string
): Promise<void> {
  // Only score on the final checkpoint.
  if (metrics.checkpoint !== "24hr") {
    console.info(`[analytics] checkpoint ${metrics.checkpoint} received for ${metrics.slotId} — waiting for 24hr`);
    return;
  }

  const sentimentScore = await scoreSentiment([], correlationId); // TODO: pass actual reply texts
  const sentimentAdjustedReplies = metrics.replies * ((sentimentScore + 1) / 2); // 0–replies range
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

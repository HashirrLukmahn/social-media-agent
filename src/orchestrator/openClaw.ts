// OpenClaw — always-on orchestrator.
// Responsibilities: timing, dispatch, content/ToS safety review, daily refresh.
// NOT the only enforcer of the kill switch — every agent checks independently.

import { GoogleGenAI } from "@google/genai";
import { harnessedCall, isPaused } from "../harness/index.js";
import { generate } from "../agents/meme-generator/index.js";
import { startSocialMediaAgent } from "../agents/social-media/index.js";
import { processMetrics } from "../agents/analytics/index.js";
import { runDailyRefresh } from "../shared/dailyRefresh.js";
import type { GeneratedMeme, PostingSlot, RawEngagementMetrics } from "../shared/types.js";

const SAFETY_REVIEW_PROMPT = `You are a content safety reviewer for a software engineering meme account on Bluesky.
The account is run by an AI and the audience is professional software developers.
Review the following meme caption and flag it if it:
- Contains anything insensitive, offensive, or harmful
- Targets any demographic group (nationality, ethnicity, gender, religion, age)
- Makes light of serious topics (mental health, job loss, financial hardship, self-harm)
- References or implies real named individuals
- Could embarrass a professional developer or their employer
- Is politically charged in any direction

Respond with ONLY one of:
SAFE
FLAGGED: <brief reason>

Caption to review:`;

let gemini: GoogleGenAI | null = null;

function getGemini(): GoogleGenAI {
  if (gemini) return gemini;
  gemini = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"] ?? "" });
  return gemini;
}

async function reviewContent(
  meme: GeneratedMeme,
  correlationId?: string
): Promise<{ safe: boolean; reason?: string }> {
  return harnessedCall(
    {
      agentName: "orchestrator",
      action: "safety-review",
      input: { caption: meme.caption.slice(0, 100) },
      correlationId,
      skipCircuitBreaker: false,
    },
    async () => {
      const ai = getGemini();
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: `${SAFETY_REVIEW_PROMPT}\n\n${meme.caption}`,
      });

      const text = (response.text ?? "").trim();
      if (text.startsWith("SAFE")) {
        return { safe: true };
      }
      const reason = text.startsWith("FLAGGED:") ? text.slice(8).trim() : "content policy";
      return { safe: false, reason };
    }
  );
}

// Full fallback chain per §6 of spec:
// 1. Generate → 2. Safety check → 3. If SAFE → release
// 4. If FLAGGED → regenerate once (conservative prompt) → 5. If FLAGGED again → fallback bank
// 6. If fallback bank empty → skip slot (do NOT post unreviewed content)
async function generateAndReview(
  slot: PostingSlot
): Promise<GeneratedMeme> {
  const { slotId, correlationId } = slot;

  // Attempt 1: normal generation
  let meme = await generate(slotId, correlationId);
  let review = await reviewContent(meme, correlationId);

  if (review.safe) return meme;

  console.warn(`[orchestrator] first generation FLAGGED (${review.reason}) — retrying with conservative prompt`);

  // Attempt 2: conservative retry (generate falls back to fallback bank on failure)
  try {
    meme = await generate(`${slotId}:conservative`, correlationId);
    review = await reviewContent(meme, correlationId);
    if (review.safe) return meme;
  } catch (err) {
    console.warn("[orchestrator] conservative retry failed:", err instanceof Error ? err.message : err);
  }

  // If still flagged or errored, generate() already falls back to the bank
  // internally. If it throws, slot must be skipped.
  throw new Error(`Slot ${slotId} skipped — all generation attempts failed safety review`);
}

let lastRefreshDay = -1;

async function maybeRunDailyRefresh(): Promise<void> {
  const dayOfYear = Math.floor(Date.now() / (24 * 60 * 60_000));
  if (dayOfYear === lastRefreshDay) return;
  lastRefreshDay = dayOfYear;

  try {
    await runDailyRefresh();
  } catch (err) {
    console.error("[orchestrator] daily refresh failed:", err instanceof Error ? err.message : err);
  }
}

export async function startOpenClaw(): Promise<void> {
  console.info("[orchestrator] OpenClaw started");

  // Run daily refresh immediately on startup (handles first-boot and restarts).
  await maybeRunDailyRefresh();

  // Start the Social Media Agent, wiring it to OpenClaw's dispatch callbacks.
  // In a multi-process Railway deployment, this communication would go through
  // Redis queues. For single-process dev and this initial build, direct calls work.
  await startSocialMediaAgent({
    onPrePing: async (slot: PostingSlot): Promise<GeneratedMeme> => {
      const paused = await isPaused().catch(() => false);
      if (paused) throw new Error("kill switch active at pre-ping");

      await maybeRunDailyRefresh();

      return generateAndReview(slot);
    },

    onMetrics: async (metrics: RawEngagementMetrics): Promise<void> => {
      // The topic isn't carried through in RawEngagementMetrics — in the full
      // implementation this would be looked up from Postgres by slotId.
      // Placeholder: pass empty string; Analytics Agent queries Postgres anyway.
      await processMetrics(metrics, "", metrics.slotId).catch((err) => {
        console.error("[orchestrator] analytics processing failed:", err instanceof Error ? err.message : err);
      });
    },
  });
}

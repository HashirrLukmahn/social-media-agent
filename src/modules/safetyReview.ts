// Full multi-layer safety chain per spec §6.
// Kept as its own module so it remains easy to point to and explain in the walkthrough.

import { harnessedCall } from "../harness/index.js";
import { completeText } from "../shared/llm.js";
import { generateMeme, getFallbackMeme } from "./memeGenerator.js";
import type { GeneratedMeme } from "../shared/types.js";

const SAFETY_REVIEW_PROMPT = `You are a content safety reviewer for a software engineering meme account on Bluesky.
The account is run by an AI and the audience is professional software developers.
Review the meme caption in the user message and flag it if it:
- Contains anything insensitive, offensive, or harmful
- Targets any demographic group (nationality, ethnicity, gender, religion, age)
- Makes light of serious topics (mental health, job loss, financial hardship, self-harm)
- References or implies real named individuals
- Could embarrass a professional developer or their employer
- Is politically charged in any direction

Respond with ONLY one of:
SAFE
FLAGGED: <brief reason>`;

export async function reviewSafety(
  meme: GeneratedMeme,
  correlationId?: string
): Promise<{ status: "SAFE" | "FLAGGED"; reason?: string }> {
  return harnessedCall(
    {
      agentName: "orchestrator",
      action: "safety-review",
      input: { caption: meme.caption.slice(0, 100) },
      correlationId,
      skipCircuitBreaker: false,
    },
    async () => {
      const text = await completeText({
        system: SAFETY_REVIEW_PROMPT,
        user: meme.caption,
        maxTokens: 64,
      });

      if (text.startsWith("SAFE")) {
        return { status: "SAFE" as const };
      }
      const reason = text.startsWith("FLAGGED:") ? text.slice(8).trim() : "content policy";
      return { status: "FLAGGED" as const, reason };
    }
  );
}

// Full generate → review → fallback chain (spec §6):
//   1. Generate → safety review → if SAFE, done
//   2. If FLAGGED → regenerate once with conservative slot ID → safety review → if SAFE, done
//   3. If still FLAGGED or error → try fallback bank
//   4. If fallback bank empty → throw (slot must be skipped, never post unreviewed content)
export async function runSafetyChain(
  slotId: string,
  correlationId?: string
): Promise<GeneratedMeme> {
  let meme = await generateMeme(slotId, correlationId);
  let review = await reviewSafety(meme, correlationId);

  if (review.status === "SAFE") return meme;

  console.warn(`[safety-review] first generation FLAGGED (${review.reason}) — retrying with conservative prompt`);

  try {
    meme = await generateMeme(`${slotId}:conservative`, correlationId);
    review = await reviewSafety(meme, correlationId);
    if (review.status === "SAFE") return meme;
  } catch (err) {
    console.warn("[safety-review] conservative retry failed:", err instanceof Error ? err.message : err);
  }

  const fallback = await getFallbackMeme();
  if (fallback) {
    console.info("[safety-review] using fallback bank after two failed safety reviews");
    return fallback;
  }

  throw new Error(`Slot ${slotId} skipped — all generation attempts failed safety review and fallback bank is empty`);
}

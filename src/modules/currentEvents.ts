// Daily current-events + public-sentiment job (§3.7 step 2).
//
// ONE Claude call with the web_search server tool returns two fields together:
//   - currentEventsContext: 3-5 short tech/cultural news bullets (optional topic
//     inspiration for the Meme Generator)
//   - publicSentimentTowardDevs: a tone-calibration read (hostile/neutral/sympathetic
//     + reason), or null when nothing notable surfaces
// Both are written into style_log:today by runDailyRefresh().
//
// Reddit was the original source for the sentiment read but is dropped entirely
// (§3.7 step 2): Reddit's Responsible Builder Policy now gates all API access
// including the previously-open .json endpoints (403 since 2026-05-30), and its
// data-use terms forbid feeding Reddit content into an LLM. Ordinary web search
// isn't subject to those platform-specific terms, so the same goal is met here.
//
// Model: claude-sonnet-4-6 per the spec's worked example (this once-daily call
// benefits from stronger reasoning for the sentiment read; the high-frequency
// classifier tasks stay on Haiku). web_search_20250305 is the basic tool variant.
//
// Single-agent flow: just one function the daily refresh calls in-process. Never
// throws — any failure resolves to empty values so the refresh is never blocked.

import { harnessedCall } from "../harness/index.js";
import { getAnthropic } from "../shared/llm.js";
import type { PublicSentiment } from "../shared/types.js";

const MODEL = "claude-sonnet-4-6";
const WEB_SEARCH_MAX_USES = 5;

export interface CurrentEventsResult {
  currentEventsContext: string[];
  publicSentimentTowardDevs: PublicSentiment | null;
}

const EMPTY: CurrentEventsResult = { currentEventsContext: [], publicSentimentTowardDevs: null };

// Single user message carrying the whole instruction (matches the spec example).
const PROMPT =
  "Search for today's top tech news and any notable World Cup moments from today. " +
  "Separately, search for and assess general public sentiment toward software " +
  "developers / tech workers as a group right now (e.g. reactions to layoffs, " +
  "'tech bro' controversies, AI-job-displacement anxiety, or any other relevant " +
  "current discourse). Return ONLY a JSON object with this exact shape, no other " +
  'text: {"currentEventsContext": ["bullet 1", "bullet 2", ...], ' +
  '"publicSentimentTowardDevs": {"tone": "hostile" | "neutral" | "sympathetic", ' +
  '"reason": "one line"} | null}. currentEventsContext should have 3-5 short, ' +
  "punchy bullets suitable as meme inspiration for a software engineering audience. " +
  "publicSentimentTowardDevs should be null if nothing notable surfaces — don't " +
  "force a tone classification on a quiet day.";

// Concatenate the text blocks of the final message (web_search_tool_result blocks
// are interleaved and ignored here — we only want the model's summary text).
function extractText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

function parseSentiment(value: unknown): PublicSentiment | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const tone = v["tone"];
  const reason = v["reason"];
  if ((tone === "hostile" || tone === "neutral" || tone === "sympathetic") && typeof reason === "string") {
    return { tone, reason };
  }
  return null;
}

// Entry point used by runDailyRefresh(). Always resolves (never throws): returns
// empty values on any API, web-search, or parse failure.
export async function fetchCurrentEvents(correlationId?: string): Promise<CurrentEventsResult> {
  try {
    const result = await harnessedCall(
      {
        agentName: "analytics",
        action: "current-events-search",
        input: { maxUses: WEB_SEARCH_MAX_USES },
        correlationId,
        skipCircuitBreaker: true, // read-only enrichment; failing open is fine
      },
      async () => {
        const response = await getAnthropic().messages.create({
          model: MODEL,
          max_tokens: 1024,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES }],
          messages: [{ role: "user", content: PROMPT }],
        });

        const text = extractText(response.content);
        const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

        let parsed: { currentEventsContext?: unknown; publicSentimentTowardDevs?: unknown };
        try {
          parsed = JSON.parse(clean) as typeof parsed;
        } catch {
          console.warn("[current-events] could not parse model response — returning empty context");
          return EMPTY;
        }

        const currentEventsContext = Array.isArray(parsed.currentEventsContext)
          ? (parsed.currentEventsContext as unknown[]).filter((e): e is string => typeof e === "string")
          : [];
        const publicSentimentTowardDevs = parseSentiment(parsed.publicSentimentTowardDevs);
        return { currentEventsContext, publicSentimentTowardDevs };
      }
    );

    console.info(
      `[current-events] ${result.currentEventsContext.length} bullets, sentiment=${result.publicSentimentTowardDevs?.tone ?? "none"}`
    );
    return result;
  } catch (err) {
    console.warn(
      "[current-events] failed, continuing refresh with no context:",
      err instanceof Error ? err.message : err
    );
    return EMPTY;
  }
}

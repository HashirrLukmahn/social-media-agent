// Thin wrapper around the Anthropic SDK for the classifier/synthesis tasks
// (safety review, sentiment, trending-theme + strategy synthesis).
//
// These were previously gemini-2.0-flash. The model lives here so it can be
// retuned in one place. Haiku is the cheap/fast tier — the spec's rationale for
// these tasks ("does not need a heavy model") still holds.

import Anthropic from "@anthropic-ai/sdk";

// Cheap/fast tier — safety review, sentiment, the like meme/humor classifier, and
// theme/strategy synthesis. These are short YES/NO or extraction tasks that don't
// need a heavy model.
export const CLASSIFIER_MODEL = "claude-haiku-4-5";

// Heavier tier for the creative meme-spec generation call. Haiku produced repetitive
// jokes/templates; Sonnet 4.6 gives more variety. Used only where passed explicitly
// (see memeGenerator.generateMemeSpec) — the default below stays on the cheap tier.
export const GENERATION_MODEL = "claude-sonnet-4-6";

let client: Anthropic | null = null;
// Shared singleton. Reads ANTHROPIC_API_KEY from the environment automatically.
// Exported for callers that need the raw client (e.g. server-tool calls like web
// search); for plain prompts prefer completeText() below.
export function getAnthropic(): Anthropic {
  if (client) return client;
  client = new Anthropic();
  return client;
}

// One-shot completion: a system instruction + a single user message, returning
// the concatenated text output (trimmed). Call this inside a harnessedCall()
// wrapper so it inherits kill-switch / circuit-breaker / retry / logging.
export async function completeText(opts: {
  system: string;
  user: string;
  maxTokens: number;
  // Optional model override. Defaults to the cheap classifier tier; pass
  // GENERATION_MODEL for the creative meme-spec call.
  model?: string;
}): Promise<string> {
  const response = await getAnthropic().messages.create({
    model: opts.model ?? CLASSIFIER_MODEL,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

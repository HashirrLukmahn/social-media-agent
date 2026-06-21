// Thin wrapper around the Anthropic SDK for the classifier/synthesis tasks
// (safety review, sentiment, trending-theme + strategy synthesis).
//
// These were previously gemini-2.0-flash. The model lives here so it can be
// retuned in one place. Haiku is the cheap/fast tier — the spec's rationale for
// these tasks ("does not need a heavy model") still holds.

import Anthropic from "@anthropic-ai/sdk";

export const CLASSIFIER_MODEL = "claude-haiku-4-5";

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
}): Promise<string> {
  const response = await getAnthropic().messages.create({
    model: CLASSIFIER_MODEL,
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

// Lightweight Slack messaging — posts to a Slack incoming webhook for both alerts
// (kill switch engaged, uncaught crash) and informational post notifications (what
// the agent posted and why). Reuses global fetch; no new dependency, no paid service.
//
// Best-effort by design: never throws, and no-ops (logging once) when
// SLACK_WEBHOOK_URL is unset — in that case the run_log entry is the fallback.

import type { GeneratedMeme } from "../shared/types.js";

let warnedMissing = false;

// Shared transport for every Slack message. Returns silently when no webhook is
// configured so callers don't have to guard.
async function postToSlack(text: string): Promise<void> {
  const url = process.env["SLACK_WEBHOOK_URL"];
  if (!url) {
    if (!warnedMissing) {
      console.warn("[alert] SLACK_WEBHOOK_URL not set — Slack messages go to run_log/stdout only");
      warnedMissing = true;
    }
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[alert] Slack webhook returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.warn("[alert] failed to send Slack message:", err instanceof Error ? err.message : err);
  }
}

export async function sendAlert(text: string): Promise<void> {
  await postToSlack(text);
}

// Fired after a meme is posted. Surfaces the agent's reasoning — chosen template,
// the topic, which style inputs (themes/events/notes) it drew on, and the hashtags
// it picked — so a human can see why a format keeps recurring and steer it.
export async function notifyMemePosted(meme: GeneratedMeme, blueskyUri?: string): Promise<void> {
  const themes =
    meme.themesReferenced.length > 0
      ? meme.themesReferenced.map((t) => `  • ${t}`).join("\n")
      : "  • (base topic only — no trending themes / current events used)";

  const lines = [
    "🟢 *Posted a new meme*",
    `*Topic:* ${meme.topic}`,
    `*Template:* ${meme.templateUsed}  _(via ${meme.generator})_`,
    `*Why this format:* ${meme.reasoning || "(no reasoning provided)"}`,
    `*Info referenced:*\n${themes}`,
    `*Hashtags:* ${meme.hashtags.join(" ")}`,
    `*Caption:* ${meme.caption}`,
  ];
  if (blueskyUri) lines.push(`*Bluesky URI:* ${blueskyUri}`);

  await postToSlack(lines.join("\n"));
}

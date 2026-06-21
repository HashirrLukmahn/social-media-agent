// Lightweight alerting — posts to a Slack incoming webhook when something needs a
// human's eyes (kill switch engaged, uncaught crash). Reuses global fetch; no new
// dependency, no paid service.
//
// Best-effort by design: never throws, and no-ops (logging once) when
// SLACK_WEBHOOK_URL is unset — in that case the run_log entry is the fallback.

let warnedMissing = false;

export async function sendAlert(text: string): Promise<void> {
  const url = process.env["SLACK_WEBHOOK_URL"];
  if (!url) {
    if (!warnedMissing) {
      console.warn("[alert] SLACK_WEBHOOK_URL not set — alerts go to run_log/stdout only");
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
    console.warn("[alert] failed to send Slack alert:", err instanceof Error ? err.message : err);
  }
}

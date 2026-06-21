import "./shared/env.js"; // must be first — loads .env before anything reads process.env
import { startScheduler } from "./scheduler.js";
import { log } from "./harness/logger.js";
import { pause } from "./harness/killSwitch.js";
import { sendAlert } from "./harness/alert.js";

// Treat an unexpected crash like a §6.1 takedown: record it, halt the system via
// the kill switch (so a restart stays paused rather than running in an unknown
// state), alert a human, then exit. Covers errors that escape the harness's
// wrapped calls (uncaught exceptions, unhandled promise rejections).
async function handleFatal(kind: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[process] ${kind}:`, message);

  // 1. Record to run_log (log() swallows its own Postgres failures).
  await log({
    agentName: "orchestrator",
    action: "uncaught-exception",
    status: "failed",
    error: `${kind}: ${message}`.slice(0, 2000),
  });

  // 2. Halt like a takedown. pause() alerts Slack on engage; if it throws (e.g.
  //    Redis unreachable), alert directly so the crash is never silent.
  try {
    await pause(`${kind}: ${message.slice(0, 300)}`);
  } catch (pauseErr) {
    await sendAlert(
      `🚨 ${kind} AND the kill switch failed to engage (${pauseErr instanceof Error ? pauseErr.message : String(pauseErr)}). System state is unknown — investigate now.\n${message.slice(0, 500)}`
    );
  }

  process.exit(1);
}

process.on("uncaughtException", (err) => {
  void handleFatal("uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  void handleFatal("unhandledRejection", reason);
});

startScheduler().catch((err) => {
  console.error("[process] fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});

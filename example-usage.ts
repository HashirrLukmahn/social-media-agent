// example-usage.ts
//
// NOT part of the app (excluded from the build) — a worked example of how a meme
// is generated through the harness. The real implementation lives in
// src/modules/memeGenerator.ts + src/modules/memegen.ts.
//
// The default generation path is Memegen.link: a free, keyless GET that returns
// the finished image. Each external call still goes through harnessedCall(), so it
// inherits the kill-switch / circuit-breaker / retry / logging treatment.

import { harnessedCall, isPaused } from "./src/harness/index.js";
import { renderMemegen } from "./src/modules/memegen.js";

// This is the shape of what the Meme Generator actually does for the render step:
// an LLM picks the template + text, then we render it via Memegen.link.
export async function renderExample(): Promise<string> {
  return harnessedCall(
    {
      agentName: "meme-generator",
      action: "memegen-render",
      input: { template: "drake" },
      attempts: 3,
      baseDelayMs: 1000,
    },
    () => renderMemegen("drake", ["Writing tests after the bug ships", "Writing tests before"])
  );
}

// Example: what happens on each path.
async function demo() {
  // Path 1 — kill switch off, circuit closed, Memegen.link responds fine.
  // → succeeds, logged as "success", circuit breaker reset to 0 failures.
  const imageUrl = await renderExample();
  console.log("Generated:", imageUrl);

  // Path 2 — if Memegen.link fails 3x in a row across separate render calls, the
  // circuit trips. The 4th call fails fast with CircuitOpenError instead of
  // retrying — and the Meme Generator falls back to the pre-approved fallback bank.

  // Path 3 — if the kill switch is flipped (e.g. a takedown fired), every
  // subsequent harnessedCall throws HarnessPausedError immediately.
  if (await isPaused()) {
    console.log("System is paused — nothing will post right now.");
  }
}

void demo;

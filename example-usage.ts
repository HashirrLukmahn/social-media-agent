// example-usage.ts
//
// This is NOT part of the harness package — it's a worked example showing
// how the meme generator agent would actually call Memelord through the
// harness. Each agent does this same pattern for its own external calls
// (social media agent → Bluesky, analytics agent → Mem0/Gemini, etc).

import { harnessedCall, isPaused } from "./index.js";

interface MemelordResponse {
  imageUrl: string;
  templateUsed: string;
}

async function callMemelord(prompt: string): Promise<MemelordResponse> {
  const res = await fetch("https://api.memelord.com/v1/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MEMELORD_API_KEY}`,
    },
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok) {
    throw new Error(`Memelord API returned ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<MemelordResponse>;
}

// This is what the meme generator agent actually calls.
export async function generateMeme(prompt: string): Promise<MemelordResponse> {
  return harnessedCall(
    {
      agentName: "meme-generator",
      action: "generate-meme",
      input: { prompt },
      attempts: 3,
      baseDelayMs: 1000,
    },
    () => callMemelord(prompt)
  );
}

// Example: what happens on each path.
async function demo() {
  // Path 1 — kill switch is off, circuit is closed, Memelord responds fine.
  // → succeeds, logged as "success", circuit breaker reset to 0 failures.
  const meme = await generateMeme(
    "junior dev deploying on a Friday, dry deadpan caption, no names"
  );
  console.log("Generated:", meme.imageUrl);

  // Path 2 — if Memelord times out 3x in a row across separate generate calls,
  // the circuit trips. The 4th call fails fast with CircuitOpenError instead
  // of waiting through 3 more retries — and OpenClaw can check this before
  // even bothering to ping the meme generator for the next post.

  // Path 3 — if someone has flipped the kill switch (e.g. you noticed a bad
  // post and paused everything), every subsequent harnessedCall across all
  // three agents throws HarnessPausedError immediately, no exceptions.
  if (await isPaused()) {
    console.log("Agent system is paused — nothing will post right now.");
  }
}

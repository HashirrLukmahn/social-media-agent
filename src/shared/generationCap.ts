// Daily generation pacing cap (§4) — replaces the old Memelord credit budget.
//
// Memegen.link is free and Magic Hour is exploratory-only, so there's no real
// spend to manage. This is a simple count: 3 mandatory (one per scheduled post)
// + up to 5 exploratory generations/day. Owned conceptually by the Analytics
// layer (the daily refresh writes it, the Meme Generator reads/increments it),
// same ownership split the credit budget had.
//
// Stored in Redis as generation_cap:today, TTL 24hr, reset by the daily refresh.

import { kvGet, kvSet } from "../harness/store.js";
import type { GenerationCap } from "./types.js";

const GENERATION_CAP_KEY = "generation_cap:today";
const TTL_SECONDS = 24 * 60 * 60;

export type GenerationType = "mandatory" | "exploratory";

// Throws if an exploratory generation would exceed the day's cap. Mandatory
// generations (the 3 scheduled posts) are always allowed. Missing cap (e.g. the
// daily refresh hasn't run) → allow but untracked, matching the old behaviour.
export async function assertGenerationAllowed(type: GenerationType): Promise<void> {
  if (type === "mandatory") return;
  const cap = await kvGet<GenerationCap>(GENERATION_CAP_KEY);
  if (!cap) return;
  if (cap.used >= cap.mandatory + cap.exploratory) {
    throw new Error(
      `Daily exploratory generation cap reached (${cap.used}/${cap.mandatory + cap.exploratory})`
    );
  }
}

// Increment the day's generation count after a meme is successfully produced.
// Best-effort: a missing cap is logged, not fatal.
export async function recordGeneration(): Promise<void> {
  const cap = await kvGet<GenerationCap>(GENERATION_CAP_KEY);
  if (!cap) {
    console.warn("[generation-cap] no generation_cap:today found — generation not counted");
    return;
  }
  await kvSet(GENERATION_CAP_KEY, { ...cap, used: cap.used + 1 }, TTL_SECONDS);
}

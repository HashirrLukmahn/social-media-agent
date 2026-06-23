// Posting plan: the per-window generator mix the scheduler posts each day.
//
// Stored under the persistent Redis key "posting_plan" (no TTL) so it survives
// restarts and carries across day boundaries. The daily analytics synthesis rewrites
// it with full autonomy; the scheduler reads it when building each day's schedule.
//
// Every read/write goes through validatePlan() so an arbitrary (LLM-proposed or
// stale) layout can never break posting: window count is normalized to POSTING_WINDOWS,
// only real generators survive, and the per-window / per-day / Magic-Hour counts are
// clamped to the constants.ts guardrails.

import { kvGet, kvSet } from "../harness/store.js";
import {
  DEFAULT_POSTING_PLAN,
  POSTING_WINDOWS,
  POSTING_PLAN_MIN_POSTS,
  POSTING_PLAN_MAX_POSTS,
  POSTING_PLAN_MAX_PER_WINDOW,
  MAGICHOUR_MAX_PER_DAY,
} from "./constants.js";
import type { Generator, PostingPlan } from "./types.js";

const POSTING_PLAN_KEY = "posting_plan"; // persistent (no TTL)

const VALID_GENERATORS: ReadonlySet<string> = new Set<Generator>(["memegen", "magichour"]);

export function defaultPlan(): PostingPlan {
  return {
    generatorsByWindow: DEFAULT_POSTING_PLAN.map((w) => [...w]),
    rationale: "Default layout — 3 Memegen + 2 Magic Hour, doubled up on the first two windows.",
    updatedAt: new Date().toISOString(),
  };
}

export function planTotalPosts(plan: PostingPlan): number {
  return plan.generatorsByWindow.reduce((sum, w) => sum + w.length, 0);
}

export function countByGenerator(plan: PostingPlan, generator: Generator): number {
  return plan.generatorsByWindow.reduce(
    (sum, w) => sum + w.filter((g) => g === generator).length,
    0
  );
}

// Coerce an arbitrary proposed layout into a safe, postable plan. Always returns a
// usable plan (falls back to the default if the input is unsalvageable).
export function validatePlan(raw: unknown, rationale: string): PostingPlan {
  const windowCount = POSTING_WINDOWS.length;

  // 1. Normalize to exactly windowCount windows of valid generators, each capped at
  //    the per-window max.
  const rawWindows = Array.isArray(raw) ? raw : [];
  const windows: Generator[][] = [];
  for (let i = 0; i < windowCount; i++) {
    const w = Array.isArray(rawWindows[i]) ? (rawWindows[i] as unknown[]) : [];
    const cleaned = w
      .filter((g): g is Generator => typeof g === "string" && VALID_GENERATORS.has(g))
      .slice(0, POSTING_PLAN_MAX_PER_WINDOW);
    windows.push(cleaned);
  }

  // 2. Cap total Magic Hour posts (cost guard) — demote the excess to Memegen,
  //    trimming from the last windows first.
  let magicHour = windows.reduce((n, w) => n + w.filter((g) => g === "magichour").length, 0);
  for (let i = windows.length - 1; i >= 0 && magicHour > MAGICHOUR_MAX_PER_DAY; i--) {
    for (let j = windows[i]!.length - 1; j >= 0 && magicHour > MAGICHOUR_MAX_PER_DAY; j--) {
      if (windows[i]![j] === "magichour") {
        windows[i]![j] = "memegen";
        magicHour--;
      }
    }
  }

  // 3. Enforce the daily post-count floor and ceiling. Add Memegen posts (to windows
  //    with spare capacity) up to the floor; drop posts from the end down to the ceiling.
  let total = windows.reduce((n, w) => n + w.length, 0);
  while (total < POSTING_PLAN_MIN_POSTS) {
    const target = windows.find((w) => w.length < POSTING_PLAN_MAX_PER_WINDOW);
    if (!target) break; // every window full — can't add more
    target.push("memegen");
    total++;
  }
  for (let i = windows.length - 1; i >= 0 && total > POSTING_PLAN_MAX_POSTS; i--) {
    while (windows[i]!.length > 0 && total > POSTING_PLAN_MAX_POSTS) {
      windows[i]!.pop();
      total--;
    }
  }

  // 4. If we somehow ended with nothing postable, fall back to the default layout.
  if (total < POSTING_PLAN_MIN_POSTS) return defaultPlan();

  return {
    generatorsByWindow: windows,
    rationale: typeof rationale === "string" && rationale.trim().length > 0
      ? rationale.trim()
      : "(no rationale provided)",
    updatedAt: new Date().toISOString(),
  };
}

// Read the active plan, validating/clamping whatever is stored. Returns the default
// when nothing is stored yet or the read fails.
export async function getPostingPlan(): Promise<PostingPlan> {
  let stored: PostingPlan | null = null;
  try {
    stored = await kvGet<PostingPlan>(POSTING_PLAN_KEY);
  } catch (err) {
    console.warn("[posting-plan] read failed — using default plan:", err instanceof Error ? err.message : err);
    return defaultPlan();
  }
  if (!stored || !Array.isArray(stored.generatorsByWindow)) return defaultPlan();
  return validatePlan(stored.generatorsByWindow, stored.rationale);
}

export async function savePostingPlan(plan: PostingPlan): Promise<void> {
  await kvSet(POSTING_PLAN_KEY, plan); // persistent — no TTL
}

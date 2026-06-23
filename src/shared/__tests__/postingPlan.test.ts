import { describe, it, expect } from "vitest";
import { validatePlan, planTotalPosts, countByGenerator } from "../postingPlan.js";
import {
  POSTING_WINDOWS,
  POSTING_PLAN_MIN_POSTS,
  POSTING_PLAN_MAX_POSTS,
  POSTING_PLAN_MAX_PER_WINDOW,
  MAGICHOUR_MAX_PER_DAY,
} from "../constants.js";

describe("validatePlan — guardrails on the daily (full-autonomy) plan rewrite", () => {
  it("normalizes to exactly POSTING_WINDOWS.length windows", () => {
    const plan = validatePlan([["memegen"], ["memegen"], ["memegen"], ["magichour"], ["magichour"]], "x");
    expect(plan.generatorsByWindow).toHaveLength(POSTING_WINDOWS.length);
  });

  it("drops invalid generator names", () => {
    const plan = validatePlan([["foo", "memegen"], ["magichour", "bar"], []], "x");
    const flat = plan.generatorsByWindow.flat();
    expect(flat).not.toContain("foo");
    expect(flat).not.toContain("bar");
    expect(flat.every((g) => g === "memegen" || g === "magichour")).toBe(true);
  });

  it("caps Magic Hour posts at the daily cost limit, demoting excess to Memegen", () => {
    const allMagic = POSTING_WINDOWS.map(() => ["magichour", "magichour"]);
    const plan = validatePlan(allMagic, "x");
    expect(countByGenerator(plan, "magichour")).toBeLessThanOrEqual(MAGICHOUR_MAX_PER_DAY);
  });

  it("caps posts per window at the double-up limit", () => {
    const plan = validatePlan([["memegen", "memegen", "memegen", "memegen"]], "x");
    for (const w of plan.generatorsByWindow) {
      expect(w.length).toBeLessThanOrEqual(POSTING_PLAN_MAX_PER_WINDOW);
    }
  });

  it("keeps the daily post count within bounds even for empty/garbage input", () => {
    for (const raw of [[], "nonsense", null, [[], [], []]]) {
      const plan = validatePlan(raw, "x");
      const total = planTotalPosts(plan);
      expect(total).toBeGreaterThanOrEqual(POSTING_PLAN_MIN_POSTS);
      expect(total).toBeLessThanOrEqual(POSTING_PLAN_MAX_POSTS);
    }
  });

  it("preserves a valid default-shaped plan unchanged", () => {
    const plan = validatePlan([["memegen", "magichour"], ["memegen", "magichour"], ["memegen"]], "stay");
    expect(plan.generatorsByWindow).toEqual([
      ["memegen", "magichour"],
      ["memegen", "magichour"],
      ["memegen"],
    ]);
    expect(countByGenerator(plan, "magichour")).toBe(2);
    expect(plan.rationale).toBe("stay");
  });
});

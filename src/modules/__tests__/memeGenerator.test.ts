// End-to-end orchestration tests for generateMeme (post-Memelord).
// Exercises the real routing + generation-cap + fallback-bank logic against an
// in-memory Redis (same approach as harness.test.ts). The network-touching pieces
// (Memegen.link render, Magic Hour, the Claude meme-spec call) are mocked here so
// the test is fast and deterministic — the real network paths are proven
// separately. generationCap and the harness run for real against the mock store.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Redis ──────────────────────────────────────────────────────────
const redisState = new Map<string, string>();
const mockRedisClient = {
  isReady: true,
  connect: vi.fn().mockResolvedValue(undefined),
  get: vi.fn(async (key: string) => redisState.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => {
    redisState.set(key, value);
    return "OK";
  }),
  lPush: vi.fn().mockResolvedValue(1),
  lTrim: vi.fn().mockResolvedValue("OK"),
  lRange: vi.fn().mockResolvedValue([]),
  on: vi.fn().mockReturnThis(),
};
vi.mock("redis", () => ({ createClient: vi.fn(() => mockRedisClient) }));

// Postgres (run-log writes) — no-op.
vi.mock("../../harness/db.js", () => ({
  insertRunLogEntry: vi.fn().mockResolvedValue(undefined),
  getRecentRunLog: vi.fn().mockResolvedValue([]),
  getRecentTemplates: vi.fn().mockResolvedValue([]),
  _resetDbForTesting: vi.fn(),
}));

// Mem0 — disabled in tests; recall returns nothing, remember is a no-op.
vi.mock("../../shared/mem0.js", () => ({
  recallRecentTemplates: vi.fn().mockResolvedValue([]),
  rememberPostedMeme: vi.fn().mockResolvedValue(undefined),
}));

// Claude meme-spec call — return a canned spec.
const completeText = vi.fn(async () =>
  JSON.stringify({ template: "drake", topText: "top", bottomText: "bottom", caption: "a relatable caption" })
);
vi.mock("../../shared/llm.js", () => ({ completeText: (...a: unknown[]) => completeText(...a), getAnthropic: vi.fn(), CLASSIFIER_MODEL: "claude-haiku-4-5", GENERATION_MODEL: "claude-sonnet-4-6" }));

// Memegen.link — controllable render.
const renderMemegen = vi.fn(async () => "https://api.memegen.link/images/drake/top/bottom.png");
vi.mock("../memegen.js", () => ({
  getTemplates: vi.fn(async () => new Map([["drake", { id: "drake", name: "Drake", lines: 2 }]])),
  renderMemegen: (...a: unknown[]) => renderMemegen(...a),
}));

// Magic Hour — controllable render; isDepletedError only affects logging.
const renderMagicHour = vi.fn(async () => "https://videos.magichour.ai/abc/output.png");
vi.mock("../magicHour.js", () => ({
  renderMagicHour: (...a: unknown[]) => renderMagicHour(...a),
  isDepletedError: () => true,
}));

import { generateMeme } from "../memeGenerator.js";
import { _resetClientForTesting } from "../../harness/store.js";
import type { GenerationCap, StyleLog } from "../../shared/types.js";

const NOW = new Date().toISOString();

function seed(capUsed = 0): void {
  const styleLog: StyleLog = {
    niche: "software-engineering",
    topics: [{ name: "deployment anxiety", timesGenerated: 0, avgScore: 0, confidence: "exploring", lastUsed: NOW }],
    formatNotes: [],
    audienceNotes: "",
    trendingThemes: [],
    blueskyTrendingThemes: [],
    currentEventsContext: [],
    publicSentimentTowardDevs: null,
    lastUpdated: NOW,
  };
  const cap: GenerationCap = { date: "2026-06-21", mandatory: 3, exploratory: 5, used: capUsed };
  redisState.set("style_log:today", JSON.stringify(styleLog));
  redisState.set("generation_cap:today", JSON.stringify(cap));
  redisState.set("fallback_bank", JSON.stringify([
    { id: "fb1", imageUrl: "https://example.com/fallback-1.png", caption: "evergreen fallback", approvedAt: NOW },
  ]));
}

function capUsed(): number {
  return (JSON.parse(redisState.get("generation_cap:today") ?? "{}") as GenerationCap).used;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetClientForTesting();
  redisState.clear();
  process.env["REDIS_URL"] = "redis://localhost:6379";
  mockRedisClient.get.mockImplementation(async (key: string) => redisState.get(key) ?? null);
  mockRedisClient.set.mockImplementation(async (key: string, value: string) => {
    redisState.set(key, value);
    return "OK";
  });
  completeText.mockResolvedValue(
    JSON.stringify({ template: "drake", topText: "top", bottomText: "bottom", caption: "a relatable caption" })
  );
  renderMemegen.mockResolvedValue("https://api.memegen.link/images/drake/top/bottom.png");
  renderMagicHour.mockResolvedValue("https://videos.magichour.ai/abc/output.png");
  seed();
});

describe("generateMeme — generator routing", () => {
  it("mandatory post uses Memegen.link and never Magic Hour", async () => {
    const meme = await generateMeme("slot-1", "corr-1", { type: "mandatory" });
    expect(meme.generator).toBe("memegen");
    expect(meme.imageUrl).toContain("api.memegen.link");
    expect(renderMagicHour).not.toHaveBeenCalled();
  });

  it("mandatory post ignores preferMagicHour (never reaches Magic Hour)", async () => {
    const meme = await generateMeme("slot-2", "corr-2", { type: "mandatory", preferMagicHour: true });
    expect(meme.generator).toBe("memegen");
    expect(renderMagicHour).not.toHaveBeenCalled();
  });

  it("exploratory + preferMagicHour routes to Magic Hour", async () => {
    const meme = await generateMeme("slot-3", "corr-3", { type: "exploratory", preferMagicHour: true });
    expect(meme.generator).toBe("magichour");
    expect(meme.imageUrl).toContain("magichour.ai");
    expect(renderMagicHour).toHaveBeenCalledOnce();
  });

  it("defaults to mandatory/Memegen when no options are given", async () => {
    const meme = await generateMeme("slot-4");
    expect(meme.generator).toBe("memegen");
    expect(renderMagicHour).not.toHaveBeenCalled();
  });
});

describe("generateMeme — graceful fallback", () => {
  it("falls back to Memegen.link when Magic Hour is depleted (low-balance guard)", async () => {
    // A depleted balance fails every attempt (incl. harness retries), so reject persistently.
    renderMagicHour.mockRejectedValue(new Error("Payment required"));
    const meme = await generateMeme("slot-5", "corr-5", { type: "exploratory", preferMagicHour: true });
    expect(meme.generator).toBe("memegen");
    expect(renderMagicHour).toHaveBeenCalled();
    expect(renderMemegen).toHaveBeenCalledOnce();
    expect(meme.imageUrl).toContain("api.memegen.link");
  });

  it("falls back to the fallback bank when generation fails entirely (no crash)", async () => {
    renderMemegen.mockRejectedValue(new Error("memegen down"));
    const meme = await generateMeme("slot-6", "corr-6", { type: "mandatory" });
    expect(meme.generator).toBe("fallback");
    expect(meme.imageUrl).toContain("example.com/fallback");
  });
});

describe("generateMeme — generation cap (§4)", () => {
  it("increments the day's used count after a successful generation", async () => {
    expect(capUsed()).toBe(0);
    await generateMeme("slot-7", "corr-7", { type: "mandatory" });
    expect(capUsed()).toBe(1);
  });

  it("blocks exploratory generations once the daily cap is reached", async () => {
    seed(8); // mandatory(3) + exploratory(5) already used
    await expect(
      generateMeme("slot-8", "corr-8", { type: "exploratory", preferMagicHour: true })
    ).rejects.toThrow(/cap reached/i);
  });

  it("still allows mandatory generations even at the cap", async () => {
    seed(8);
    const meme = await generateMeme("slot-9", "corr-9", { type: "mandatory" });
    expect(meme.generator).toBe("memegen");
  });
});

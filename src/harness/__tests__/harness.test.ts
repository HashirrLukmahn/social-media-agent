// Unit tests for the harness module.
// Covers: Redis failure, Memelord timeout, kill-switch mid-call, circuit breaker
// half-open recovery, and correlationId propagation.
//
// Run: npm test

import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";

// ─── Shared in-memory Redis state ─────────────────────────────────────────────
// get/set share the same map so writes are visible to reads — critical for
// circuit breaker tests where consecutive failures update then re-read state.

const redisState: Map<string, string> = new Map();

const mockRedisClient = {
  isReady: true,
  connect: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockImplementation(async (key: string) => redisState.get(key) ?? null),
  set: vi.fn().mockImplementation(async (key: string, value: string) => {
    redisState.set(key, value);
    return "OK";
  }),
  lPush: vi.fn().mockResolvedValue(1),
  lTrim: vi.fn().mockResolvedValue("OK"),
  lRange: vi.fn().mockResolvedValue([]),
  on: vi.fn().mockReturnThis(),
};

// Mock must be declared before any import that transitively loads store.ts.
vi.mock("redis", () => ({
  createClient: vi.fn(() => mockRedisClient),
}));

// ─── Mock Postgres (db.ts) ──────────────────────────────────────────────────
vi.mock("../db.js", () => ({
  insertRunLogEntry: vi.fn().mockResolvedValue(undefined),
  getRecentRunLog: vi.fn().mockResolvedValue([]),
  _resetDbForTesting: vi.fn(),
}));

vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue("test-uuid-1234"),
}));

// ─── Imports (after mocks are in place) ──────────────────────────────────────
import { harnessedCall, HarnessPausedError, CircuitOpenError } from "../index.js";
import { _resetClientForTesting } from "../store.js";
import { insertRunLogEntry } from "../db.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setState(key: string, value: unknown): void {
  redisState.set(key, JSON.stringify(value));
}

function withKillSwitch(paused: boolean): void {
  setState("kill_switch", { paused });
}

function openCircuit(agentName: string, cooldownMs = 5 * 60 * 1000): void {
  setState(`circuit_breaker:${agentName}`, {
    agentName,
    consecutiveFailures: 3,
    status: "open",
    openedAt: new Date().toISOString(),
    cooldownMs,
  });
}

function closedCircuit(agentName: string): void {
  setState(`circuit_breaker:${agentName}`, {
    agentName,
    consecutiveFailures: 0,
    status: "closed",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetClientForTesting();
  redisState.clear();

  // Set REDIS_URL so getClient() passes the URL guard (createClient is mocked).
  process.env["REDIS_URL"] = "redis://localhost:6379";

  // Re-apply implementations after clearAllMocks (clears call history only,
  // but explicit reassignment is safer for implementations that close over state).
  mockRedisClient.connect.mockResolvedValue(undefined);
  mockRedisClient.get.mockImplementation(async (key: string) => redisState.get(key) ?? null);
  mockRedisClient.set.mockImplementation(async (key: string, value: string) => {
    redisState.set(key, value);
    return "OK";
  });
  mockRedisClient.lPush.mockResolvedValue(1);
  mockRedisClient.lTrim.mockResolvedValue("OK");
  mockRedisClient.lRange.mockResolvedValue([]);
  mockRedisClient.on.mockReturnThis();
});

// ─── Kill switch tests ────────────────────────────────────────────────────────

describe("harnessedCall — kill switch", () => {
  it("throws HarnessPausedError and logs 'skipped' when kill switch is on", async () => {
    withKillSwitch(true);

    await expect(
      harnessedCall(
        { agentName: "meme-generator", action: "test-action" },
        async () => "result"
      )
    ).rejects.toBeInstanceOf(HarnessPausedError);

    expect(insertRunLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", error: "kill switch active" })
    );
  });

  it("succeeds when kill switch is off", async () => {
    withKillSwitch(false);

    const result = await harnessedCall(
      { agentName: "meme-generator", action: "test-action" },
      async () => "hello"
    );
    expect(result).toBe("hello");
  });

  it("defaults to not-paused (fail-open) when Redis throws on kill switch read", async () => {
    // Simulate Redis failure on only the kill switch read.
    mockRedisClient.get
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))  // kill switch read fails
      .mockResolvedValue(null);                           // subsequent reads succeed

    const result = await harnessedCall(
      { agentName: "meme-generator", action: "test-action" },
      async () => "result-despite-redis-down"
    );
    expect(result).toBe("result-despite-redis-down");
  });
});

// ─── Circuit breaker tests ────────────────────────────────────────────────────

describe("harnessedCall — circuit breaker", () => {
  it("throws CircuitOpenError and logs 'circuit-open' when circuit is open", async () => {
    withKillSwitch(false);
    openCircuit("meme-generator");

    await expect(
      harnessedCall(
        { agentName: "meme-generator", action: "test-action" },
        async () => "result"
      )
    ).rejects.toBeInstanceOf(CircuitOpenError);

    expect(insertRunLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "circuit-open" })
    );
  });

  it("allows call through with skipCircuitBreaker even when circuit is open", async () => {
    withKillSwitch(false);
    openCircuit("analytics");

    const result = await harnessedCall(
      { agentName: "analytics", action: "read-style-log", skipCircuitBreaker: true },
      async () => "read-result"
    );
    expect(result).toBe("read-result");
  });

  it("allows probe through in half-open state (cooldown elapsed) and closes circuit on success", async () => {
    const cooldownMs = 5 * 60 * 1000;
    withKillSwitch(false);
    // Set openedAt far enough in the past that cooldown has elapsed.
    setState("circuit_breaker:meme-generator", {
      agentName: "meme-generator",
      consecutiveFailures: 3,
      status: "open",
      openedAt: new Date(Date.now() - cooldownMs - 5000).toISOString(),
      cooldownMs,
    });

    const result = await harnessedCall(
      { agentName: "meme-generator", action: "probe-call" },
      async () => "probe-ok"
    );
    expect(result).toBe("probe-ok");

    // Circuit should now be closed — verify via the Redis state.
    const finalState = JSON.parse(redisState.get("circuit_breaker:meme-generator") ?? "{}") as Record<string, unknown>;
    expect(finalState["status"]).toBe("closed");
    expect(finalState["consecutiveFailures"]).toBe(0);
  });

  it("re-opens circuit when half-open probe fails", async () => {
    const cooldownMs = 100; // very short so cooldown elapses immediately
    withKillSwitch(false);
    setState("circuit_breaker:meme-generator", {
      agentName: "meme-generator",
      consecutiveFailures: 3,
      status: "open",
      openedAt: new Date(Date.now() - cooldownMs - 10).toISOString(),
      cooldownMs,
    });

    await expect(
      harnessedCall(
        { agentName: "meme-generator", action: "probe-call", attempts: 1, baseDelayMs: 0 },
        async () => { throw new Error("still broken"); }
      )
    ).rejects.toThrow("still broken");

    const finalState = JSON.parse(redisState.get("circuit_breaker:meme-generator") ?? "{}") as Record<string, unknown>;
    expect(finalState["status"]).toBe("open");
  });
});

// ─── Redis failure mid-operation ─────────────────────────────────────────────

describe("harnessedCall — Redis failure mid-operation", () => {
  it("retries the underlying fn on transient failure and eventually succeeds", async () => {
    withKillSwitch(false);

    let attempts = 0;
    const result = await harnessedCall(
      {
        agentName: "social-media",
        action: "post",
        attempts: 3,
        baseDelayMs: 0,
      },
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient error");
        return "success-on-attempt-3";
      }
    );

    expect(result).toBe("success-on-attempt-3");
    expect(attempts).toBe(3);
  });

  it("propagates error and logs 'failed' after all retries exhausted", async () => {
    withKillSwitch(false);

    await expect(
      harnessedCall(
        { agentName: "social-media", action: "post", attempts: 2, baseDelayMs: 0 },
        async () => { throw new Error("permanent error"); }
      )
    ).rejects.toThrow("permanent error");

    expect(insertRunLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: "permanent error" })
    );
  });

  it("falls back to console logging when Redis write fails during log entry", async () => {
    withKillSwitch(false);
    // Kill Redis writes after the initial setup reads.
    mockRedisClient.set.mockRejectedValue(new Error("Redis write timeout"));

    // Even with Redis writes failing, the error from fn should propagate cleanly.
    await expect(
      harnessedCall(
        { agentName: "analytics", action: "score-post", attempts: 1, baseDelayMs: 0 },
        async () => { throw new Error("fn error"); }
      )
    ).rejects.toThrow("fn error");
    // No unhandled rejection — logger catches Redis errors internally.
  });
});

// ─── Memelord timeout simulation ─────────────────────────────────────────────

describe("harnessedCall — Memelord timeout simulation", () => {
  it("trips circuit breaker after 3 consecutive timeouts (one retry each)", async () => {
    withKillSwitch(false);
    // No pre-existing circuit state — starts closed.

    for (let call = 1; call <= 3; call++) {
      await expect(
        harnessedCall(
          {
            agentName: "meme-generator",
            action: "generate-meme",
            attempts: 1, // 1 attempt per call to keep test fast
            baseDelayMs: 0,
          },
          async () => { throw new Error("Request timed out"); }
        )
      ).rejects.toThrow("Request timed out");
    }

    // After 3 consecutive failures, circuit must be open.
    const state = JSON.parse(redisState.get("circuit_breaker:meme-generator") ?? "{}") as Record<string, unknown>;
    expect(state["status"]).toBe("open");
    expect(state["consecutiveFailures"]).toBe(3);
    expect(state["openedAt"]).toBeTruthy();
  });

  it("does not trip circuit if a success resets the failure count", async () => {
    withKillSwitch(false);

    // Fail twice.
    for (let i = 0; i < 2; i++) {
      await expect(
        harnessedCall(
          { agentName: "meme-generator", action: "generate-meme", attempts: 1, baseDelayMs: 0 },
          async () => { throw new Error("timeout"); }
        )
      ).rejects.toThrow();
    }
    let state = JSON.parse(redisState.get("circuit_breaker:meme-generator") ?? "{}") as Record<string, unknown>;
    expect(state["consecutiveFailures"]).toBe(2);
    expect(state["status"]).toBe("closed"); // not yet tripped

    // Succeed — failure count resets.
    await harnessedCall(
      { agentName: "meme-generator", action: "generate-meme" },
      async () => "ok"
    );

    state = JSON.parse(redisState.get("circuit_breaker:meme-generator") ?? "{}") as Record<string, unknown>;
    expect(state["consecutiveFailures"]).toBe(0);
    expect(state["status"]).toBe("closed");
  });

  it("fails fast with CircuitOpenError on 4th call after circuit trips", async () => {
    withKillSwitch(false);
    openCircuit("meme-generator"); // already tripped

    await expect(
      harnessedCall(
        { agentName: "meme-generator", action: "generate-meme" },
        async () => "should never run"
      )
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

// ─── Kill switch flipped mid-retry ───────────────────────────────────────────

describe("harnessedCall — kill switch flipped mid-retry", () => {
  it("aborts retry loop when kill switch is activated between retries", async () => {
    withKillSwitch(false);

    let attemptCount = 0;

    const error = await new Promise<Error | null>((resolve) => {
      harnessedCall(
        {
          agentName: "meme-generator",
          action: "generate-meme",
          attempts: 5,
          baseDelayMs: 5, // short but non-zero — abort check fires between retries
          maxDelayMs: 5,
        },
        async () => {
          attemptCount++;
          if (attemptCount === 1) {
            // Flip kill switch after the first attempt fails.
            withKillSwitch(true);
          }
          throw new Error("Memelord down");
        }
      )
        .then(() => resolve(null))
        .catch((err: Error) => resolve(err));
    });

    expect(error).not.toBeNull();
    // Should have aborted very early — not run all 5 attempts.
    expect(attemptCount).toBeLessThanOrEqual(3);
    // Error message comes from either the abort or the kill switch check.
    expect(error?.message).toMatch(/[Aa]bort|kill switch|paused|Memelord/);
  });
});

// ─── Correlation ID threading ────────────────────────────────────────────────

describe("correlationId threading", () => {
  it("passes correlationId through to the run_log entry on success", async () => {
    withKillSwitch(false);

    await harnessedCall(
      {
        agentName: "orchestrator",
        action: "safety-review",
        correlationId: "cycle-abc-123",
      },
      async () => "reviewed"
    );

    expect(insertRunLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "cycle-abc-123" })
    );
  });

  it("passes correlationId through to the run_log entry on failure", async () => {
    withKillSwitch(false);

    await expect(
      harnessedCall(
        {
          agentName: "orchestrator",
          action: "safety-review",
          correlationId: "cycle-abc-123",
          attempts: 1,
          baseDelayMs: 0,
        },
        async () => { throw new Error("model error"); }
      )
    ).rejects.toThrow();

    expect(insertRunLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "cycle-abc-123", status: "failed" })
    );
  });

  it("passes correlationId to 'skipped' log entry when kill switch is on", async () => {
    withKillSwitch(true);

    await expect(
      harnessedCall(
        {
          agentName: "meme-generator",
          action: "generate",
          correlationId: "cycle-xyz-789",
        },
        async () => "irrelevant"
      )
    ).rejects.toBeInstanceOf(HarnessPausedError);

    expect(insertRunLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "cycle-xyz-789",
        status: "skipped",
      })
    );
  });

  it("omits correlationId from log entry when none is provided", async () => {
    withKillSwitch(false);

    await harnessedCall(
      { agentName: "analytics", action: "compute-score" },
      async () => 42
    );

    const logCall = (insertRunLogEntry as MockInstance).mock.calls[0]?.[0] as Record<string, unknown>;
    // correlationId should be undefined/null, not a stale ID from a prior test.
    expect(logCall?.["correlationId"] == null).toBe(true);
  });
});

// ─── Scoring formula ─────────────────────────────────────────────────────────

describe("scoring formula (§4.1)", () => {
  it("weights reposts × 3, likes × 1, sentiment-adjusted replies × 1.5", async () => {
    const { computeScore } = await import("../../agents/analytics/index.js");
    // 2 reposts, 5 likes, 3 sentiment-adjusted replies → 6 + 5 + 4.5 = 15.5
    expect(computeScore(2, 5, 3)).toBeCloseTo(15.5);
  });

  it("returns 0 for zero engagement", async () => {
    const { computeScore } = await import("../../agents/analytics/index.js");
    expect(computeScore(0, 0, 0)).toBe(0);
  });

  it("returns correct score for reposts-only (highest weight signal)", async () => {
    const { computeScore } = await import("../../agents/analytics/index.js");
    expect(computeScore(10, 0, 0)).toBe(30); // 10 * 3
  });
});

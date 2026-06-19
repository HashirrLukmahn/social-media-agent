// The one function every agent wraps its external calls with.
//
// Execution order (fixed):
//   1. Kill switch check — refuse immediately if paused
//   2. Circuit breaker check — refuse if this agent is in open/cooling state
//   3. Retry with exponential backoff — attempt the call up to N times
//   4. Log — always write a record, success or failure
//
// correlationId ties together all harnessedCall invocations that belong to
// one logical posting cycle (pre-ping → generate → safety-review → post →
// poll → score). Pass the same ID through the whole chain; it's stored on
// every run_log row so the cycle is queryable end-to-end.

import { isCircuitOpen, recordFailure, recordSuccess } from "./circuitBreaker.js";
import { isPaused } from "./killSwitch.js";
import { log } from "./logger.js";
import { retryWithBackoff } from "./retry.js";
import type { AgentName, RetryOptions } from "./types.js";

export class HarnessPausedError extends Error {
  constructor(reason?: string) {
    super(`Harness is paused${reason ? `: ${reason}` : ""}`);
    this.name = "HarnessPausedError";
  }
}

export class CircuitOpenError extends Error {
  constructor(agentName: AgentName) {
    super(`Circuit breaker is open for ${agentName} — too many consecutive failures`);
    this.name = "CircuitOpenError";
  }
}

interface HarnessedCallOptions extends RetryOptions {
  agentName: AgentName;
  action: string;
  input?: unknown;
  correlationId?: string;
  // Skip the circuit breaker for read-only / idempotent calls where failing
  // open is safer than refusing to run (e.g. reading the style log).
  skipCircuitBreaker?: boolean;
}

export async function harnessedCall<T>(
  options: HarnessedCallOptions,
  fn: () => Promise<T>
): Promise<T> {
  const { agentName, action, input, correlationId, skipCircuitBreaker, ...retryOptions } = options;

  // Kill switch: fail-open if Redis is unreadable (transient Redis issue ≠
  // intentional pause; reconnect logic will restore the check on the next call).
  let paused = false;
  try {
    paused = await isPaused();
  } catch {
    console.warn(
      `[harness:${agentName}] kill switch unreadable (Redis down?), defaulting to not-paused`
    );
  }

  if (paused) {
    await log({ agentName, action, status: "skipped", input, correlationId, error: "kill switch active" });
    throw new HarnessPausedError();
  }

  if (!skipCircuitBreaker) {
    let circuitOpen = false;
    try {
      circuitOpen = await isCircuitOpen(agentName);
    } catch {
      console.warn(`[harness:${agentName}] circuit breaker unreadable, defaulting to closed`);
    }

    if (circuitOpen) {
      await log({ agentName, action, status: "circuit-open", input, correlationId });
      throw new CircuitOpenError(agentName);
    }
  }

  const start = Date.now();
  try {
    const result = await retryWithBackoff(fn, retryOptions, isPaused);
    await recordSuccess(agentName).catch((e) =>
      console.error(`[harness:${agentName}] recordSuccess failed:`, e instanceof Error ? e.message : e)
    );
    await log({
      agentName,
      action,
      status: "success",
      input,
      output: result as unknown,
      durationMs: Date.now() - start,
      correlationId,
    });
    return result;
  } catch (err) {
    // Guard infra calls so a Redis blip can't mask the original fn error.
    await recordFailure(agentName).catch((e) =>
      console.error(`[harness:${agentName}] recordFailure failed:`, e instanceof Error ? e.message : e)
    );
    const message = err instanceof Error ? err.message : String(err);
    await log({
      agentName,
      action,
      status: "failed",
      input,
      error: message,
      durationMs: Date.now() - start,
      correlationId,
    });
    throw err;
  }
}

export { isPaused, pause, resume, getKillSwitchState } from "./killSwitch.js";
export { isCircuitOpen, resetCircuit, getCircuitState } from "./circuitBreaker.js";
export { getRecentLogs } from "./logger.js";
export type { AgentName, LogEntry } from "./types.js";

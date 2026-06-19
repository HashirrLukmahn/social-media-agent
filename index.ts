// harness/index.ts
//
// This is the one function every agent imports and wraps its external calls
// with. It composes the four pieces in a fixed order:
//
//   1. kill switch check   — refuse to act at all if paused
//   2. circuit breaker check — refuse if this agent has failed too many times in a row
//   3. retry with backoff  — give the call a few chances against transient errors
//   4. log                 — always write a record, success or failure
//
// Each agent calls this independently. There's no central enforcer — that's
// deliberate, see the conversation that led here: a single point of
// enforcement is a single point of failure.

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
  // Skip the circuit breaker check for read-only / idempotent calls where
  // failing open is safer than refusing to run (e.g. reading the style log).
  skipCircuitBreaker?: boolean;
}

export async function harnessedCall<T>(
  options: HarnessedCallOptions,
  fn: () => Promise<T>
): Promise<T> {
  const { agentName, action, input, skipCircuitBreaker, ...retryOptions } = options;

  if (await isPaused()) {
    await log({ agentName, action, status: "skipped", input, error: "kill switch active" });
    throw new HarnessPausedError();
  }

  if (!skipCircuitBreaker && (await isCircuitOpen(agentName))) {
    await log({ agentName, action, status: "circuit-open", input });
    throw new CircuitOpenError(agentName);
  }

  const start = Date.now();
  try {
    const result = await retryWithBackoff(fn, retryOptions);
    await recordSuccess(agentName);
    await log({
      agentName,
      action,
      status: "success",
      input,
      output: result,
      durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    await recordFailure(agentName);
    const message = err instanceof Error ? err.message : String(err);
    await log({
      agentName,
      action,
      status: "failed",
      input,
      error: message,
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

// Re-export everything an agent might need individually too —
// e.g. OpenClaw checking another agent's breaker status before dispatching,
// or a manual admin script flipping the kill switch.
export { isPaused, pause, resume, getKillSwitchState } from "./killSwitch.js";
export { isCircuitOpen, resetCircuit } from "./circuitBreaker.js";
export { getRecentLogs, getRecentLogsForAgent } from "./logger.js";
export type { AgentName, LogEntry } from "./types.js";

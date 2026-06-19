// Scoped per-agent circuit breaker with automatic half-open recovery.
//
// State machine:
//   CLOSED → (3 consecutive failures) → OPEN
//   OPEN   → (cooldown elapsed)        → HALF-OPEN
//   HALF-OPEN → (probe succeeds)       → CLOSED
//   HALF-OPEN → (probe fails)          → OPEN  (cooldown resets)
//
// Auto-reset vs. manual reset tradeoff (for unsupervised operation):
//
//   Auto-reset (this implementation):
//   + Recovers from transient outages without human intervention — essential
//     for a system running unsupervised for multiple days.
//   + Half-open state lets one probe through instead of flooding the recovering
//     service, so recovery is gradual.
//   - If the failure is permanent (wrong API key, decommissioned endpoint),
//     the system cycles open→half-open→open on the cooldown interval, never
//     recovering. This is visible in the run_log as repeated "circuit-open"
//     entries — the signal to investigate.
//
//   Manual reset:
//   + Forces a human to confirm the underlying issue is fixed before retrying.
//   - Completely incompatible with unsupervised multi-day operation.
//
//   Decision: auto-reset with 5-minute cooldown. The repeated open/half-open
//   cycling on permanent failures IS the alert mechanism — monitor the run_log.

import { kvGet, kvSet } from "./store.js";
import type { AgentName, CircuitBreakerState, CircuitStatus } from "./types.js";

const FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function breakerKey(agentName: AgentName): string {
  return `circuit_breaker:${agentName}`;
}

async function getState(agentName: AgentName): Promise<CircuitBreakerState> {
  const state = await kvGet<CircuitBreakerState>(breakerKey(agentName));
  return state ?? { agentName, consecutiveFailures: 0, status: "closed" };
}

export async function isCircuitOpen(agentName: AgentName): Promise<boolean> {
  const state = await getState(agentName);

  if (state.status === "closed") return false;

  if (state.status === "open" && state.openedAt) {
    const elapsed = Date.now() - new Date(state.openedAt).getTime();
    const cooldown = state.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    if (elapsed >= cooldown) {
      // Transition to half-open: allow one probe through.
      const halfOpenState: CircuitBreakerState = {
        ...state,
        status: "half-open",
        halfOpenAt: new Date().toISOString(),
      };
      await kvSet(breakerKey(agentName), halfOpenState);
      console.warn(
        `[circuit:${agentName}] cooldown elapsed, transitioning to half-open — allowing probe`
      );
      return false; // let the probe through
    }
  }

  if (state.status === "half-open") {
    // Already in half-open: let the probe through. If multiple calls arrive
    // simultaneously, they all get through — acceptable at this traffic volume
    // (3 posts/day), and simpler than a single-probe lock.
    return false;
  }

  return true; // circuit is open
}

export async function recordSuccess(agentName: AgentName): Promise<void> {
  const state = await getState(agentName);

  if (state.status !== "closed") {
    const wasHalfOpen = state.status === "half-open";
    console.info(
      `[circuit:${agentName}] probe succeeded${wasHalfOpen ? " (half-open)" : ""}, closing circuit`
    );
  }

  await kvSet(breakerKey(agentName), {
    agentName,
    consecutiveFailures: 0,
    status: "closed" as CircuitStatus,
  } satisfies CircuitBreakerState);
}

export async function recordFailure(agentName: AgentName): Promise<void> {
  const state = await getState(agentName);
  const consecutiveFailures = state.consecutiveFailures + 1;
  const shouldOpen = consecutiveFailures >= FAILURE_THRESHOLD;

  const newState: CircuitBreakerState = {
    agentName,
    consecutiveFailures,
    status: shouldOpen ? ("open" as CircuitStatus) : ("closed" as CircuitStatus),
    cooldownMs: state.cooldownMs,
  };

  if (shouldOpen) {
    // Reset openedAt on each open/re-open so the cooldown timer restarts.
    // This covers the half-open → fail → back to open path.
    newState.openedAt = new Date().toISOString();
    const wasHalfOpen = state.status === "half-open";
    console.error(
      `[circuit:${agentName}] circuit opening${wasHalfOpen ? " (probe failed)" : ""} — ${consecutiveFailures} consecutive failures`
    );
  }

  await kvSet(breakerKey(agentName), newState);
}

// Manual override — for admin scripts or one-time debugging.
// Not needed for normal operation (auto-reset handles recovery).
export async function resetCircuit(agentName: AgentName): Promise<void> {
  await kvSet(breakerKey(agentName), {
    agentName,
    consecutiveFailures: 0,
    status: "closed" as CircuitStatus,
  } satisfies CircuitBreakerState);
}

export async function getCircuitState(agentName: AgentName): Promise<CircuitBreakerState> {
  return getState(agentName);
}

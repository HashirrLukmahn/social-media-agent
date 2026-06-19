// harness/circuitBreaker.ts
//
// Scoped per-agent, not centralized. Each agent tracks its own consecutive
// failures and trips its own breaker — it doesn't need OpenClaw to tell it
// "you've failed 3 times," it knows that about itself.

import { kvGet, kvSet } from "./store.js";
import type { AgentName, CircuitBreakerState } from "./types.js";

const FAILURE_THRESHOLD = 3;

function breakerKey(agentName: AgentName): string {
  return `circuit_breaker:${agentName}`;
}

async function getState(agentName: AgentName): Promise<CircuitBreakerState> {
  const state = await kvGet<CircuitBreakerState>(breakerKey(agentName));
  return state ?? { agentName, consecutiveFailures: 0, isOpen: false };
}

export async function isCircuitOpen(agentName: AgentName): Promise<boolean> {
  const state = await getState(agentName);
  return state.isOpen;
}

export async function recordSuccess(agentName: AgentName): Promise<void> {
  // A success fully resets the breaker — we only care about *consecutive* failures.
  await kvSet(breakerKey(agentName), {
    agentName,
    consecutiveFailures: 0,
    isOpen: false,
  } satisfies CircuitBreakerState);
}

export async function recordFailure(agentName: AgentName): Promise<void> {
  const state = await getState(agentName);
  const consecutiveFailures = state.consecutiveFailures + 1;
  const isOpen = consecutiveFailures >= FAILURE_THRESHOLD;

  const newState: CircuitBreakerState = {
    agentName,
    consecutiveFailures,
    isOpen,
  };
  if (isOpen) {
    newState.openedAt = state.openedAt ?? new Date().toISOString();
  }
  await kvSet(breakerKey(agentName), newState);
}

// Manual reset — for when you've investigated a tripped breaker and confirmed
// it's safe to let the agent try again.
export async function resetCircuit(agentName: AgentName): Promise<void> {
  await kvSet(breakerKey(agentName), {
    agentName,
    consecutiveFailures: 0,
    isOpen: false,
  } satisfies CircuitBreakerState);
}

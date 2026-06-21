// Defense in depth: every agent checks this independently before posting,
// generating, or spending credit — not just OpenClaw before dispatching.
// That way a bug or restart in the orchestrator can't bypass the pause.

import { kvGet, kvSet } from "./store.js";
import { sendAlert } from "./alert.js";
import type { KillSwitchState } from "./types.js";

const KILL_SWITCH_KEY = "kill_switch";

export async function isPaused(): Promise<boolean> {
  const state = await kvGet<KillSwitchState>(KILL_SWITCH_KEY);
  return state?.paused ?? false;
}

export async function pause(reason: string): Promise<void> {
  const state: KillSwitchState = {
    paused: true,
    reason,
    pausedAt: new Date().toISOString(),
  };
  try {
    await kvSet(KILL_SWITCH_KEY, state);
  } finally {
    // Any kill-switch engage (crash handler, §6.1 takedown, or manual pause) pings
    // Slack so a human sees it. Runs even if the state write above failed, so a
    // Redis outage during a halt is never silent. sendAlert never throws.
    await sendAlert(`🚨 Kill switch ENGAGED — system paused.\nReason: ${reason}`);
  }
}

export async function resume(): Promise<void> {
  const state: KillSwitchState = { paused: false };
  await kvSet(KILL_SWITCH_KEY, state);
}

export async function getKillSwitchState(): Promise<KillSwitchState> {
  const state = await kvGet<KillSwitchState>(KILL_SWITCH_KEY);
  return state ?? { paused: false };
}

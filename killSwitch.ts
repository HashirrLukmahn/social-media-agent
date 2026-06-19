// harness/killSwitch.ts
//
// Defense in depth: every agent checks this independently before posting,
// generating, or spending credit — not just OpenClaw before dispatching.
// That way a bug in the orchestrator can't bypass the pause.

import { kvGet, kvSet } from "./store.js";
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
  await kvSet(KILL_SWITCH_KEY, state);
}

export async function resume(): Promise<void> {
  const state: KillSwitchState = { paused: false };
  await kvSet(KILL_SWITCH_KEY, state);
}

export async function getKillSwitchState(): Promise<KillSwitchState> {
  const state = await kvGet<KillSwitchState>(KILL_SWITCH_KEY);
  return state ?? { paused: false };
}

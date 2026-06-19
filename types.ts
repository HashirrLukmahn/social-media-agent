// harness/types.ts

export type AgentName = "meme-generator" | "social-media" | "analytics" | "orchestrator";

export interface LogEntry {
  timestamp: string;
  agentName: AgentName;
  action: string;
  status: "success" | "failed" | "skipped" | "circuit-open";
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface CircuitBreakerState {
  agentName: AgentName;
  consecutiveFailures: number;
  isOpen: boolean;
  openedAt?: string;
}

export interface KillSwitchState {
  paused: boolean;
  reason?: string;
  pausedAt?: string;
}

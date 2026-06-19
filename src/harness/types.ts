export type AgentName = "meme-generator" | "social-media" | "analytics" | "orchestrator";

export interface LogEntry {
  id: string;
  correlationId?: string;
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

export type CircuitStatus = "closed" | "open" | "half-open";

export interface CircuitBreakerState {
  agentName: AgentName;
  consecutiveFailures: number;
  status: CircuitStatus;
  openedAt?: string;
  halfOpenAt?: string;
  cooldownMs?: number;
}

export interface KillSwitchState {
  paused: boolean;
  reason?: string;
  pausedAt?: string;
}

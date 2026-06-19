// harness/logger.ts

import { kvAppend, kvList } from "./store.js";
import type { AgentName, LogEntry } from "./types.js";

const LOG_KEY = "run_log";

export async function log(entry: Omit<LogEntry, "timestamp">): Promise<void> {
  const fullEntry: LogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };

  // Console output too — useful for live Railway logs during development.
  const tag = `[${fullEntry.agentName}:${fullEntry.action}]`;
  if (fullEntry.status === "failed") {
    console.error(tag, fullEntry.status, fullEntry.error ?? "");
  } else {
    console.log(tag, fullEntry.status);
  }

  await kvAppend(LOG_KEY, fullEntry);
}

export async function getRecentLogs(count = 100): Promise<LogEntry[]> {
  return kvList<LogEntry>(LOG_KEY, count);
}

export async function getRecentLogsForAgent(
  agentName: AgentName,
  count = 50
): Promise<LogEntry[]> {
  // Pull a larger window then filter — simplest correct approach given
  // this is a single Redis list rather than per-agent streams.
  const recent = await kvList<LogEntry>(LOG_KEY, 500);
  return recent.filter((e: LogEntry) => e.agentName === agentName).slice(0, count);
}

// Writes structured log entries to Postgres (run_log table) and to stdout.
//
// Intentionally does NOT go through harnessedCall — circular dependency.
// Postgres writes fail silently (console-only fallback) so a db blip never
// silences the process output or crashes the system.

import { v4 as uuidv4 } from "uuid";
import { insertRunLogEntry, getRecentRunLog } from "./db.js";
import type { AgentName, LogEntry } from "./types.js";

export async function log(entry: Omit<LogEntry, "id" | "timestamp">): Promise<void> {
  const fullEntry: LogEntry = {
    ...entry,
    id: uuidv4(),
    timestamp: new Date().toISOString(),
  };

  const tag = `[${fullEntry.agentName}:${fullEntry.action}]`;
  if (fullEntry.status === "failed") {
    console.error(tag, fullEntry.status, fullEntry.error ?? "");
  } else {
    console.log(tag, fullEntry.status, fullEntry.correlationId ? `corr=${fullEntry.correlationId}` : "");
  }

  try {
    await insertRunLogEntry({
      id: fullEntry.id,
      correlationId: fullEntry.correlationId ?? null,
      agentName: fullEntry.agentName,
      action: fullEntry.action,
      status: fullEntry.status,
      durationMs: fullEntry.durationMs ?? null,
      input: (fullEntry.input as Record<string, unknown> | null) ?? null,
      output: (fullEntry.output as Record<string, unknown> | null) ?? null,
      error: fullEntry.error ?? null,
    });
  } catch (err) {
    // Log db write failures to stderr but don't propagate — process stdout is
    // the fallback and Railway logs capture it.
    console.error("[harness:logger] failed to write run_log to Postgres:", err instanceof Error ? err.message : err);
  }
}

export async function getRecentLogs(count = 100): Promise<LogEntry[]> {
  const rows = await getRecentRunLog(count);
  return rows.map((r) => ({
    id: r.id,
    correlationId: r.correlationId ?? undefined,
    timestamp: r.timestamp.toISOString(),
    agentName: r.agentName as AgentName,
    action: r.action,
    status: r.status as LogEntry["status"],
    durationMs: r.durationMs ?? undefined,
    input: r.input ?? undefined,
    output: r.output ?? undefined,
    error: r.error ?? undefined,
  }));
}

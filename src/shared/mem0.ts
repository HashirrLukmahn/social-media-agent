// Mem0 — semantic, qualitative memory for the Analytics layer (§2.3 / §3.5).
//
// This is the unstructured, semantically-retrieved layer that sits ALONGSIDE the
// structured Postgres style log — for cross-cutting qualitative observations that
// don't fit a row/column (e.g. "engagement consistently drops on Fridays
// regardless of topic"). It does NOT replace the existing Claude-based strategy
// synthesis; it accumulates and recalls free-text learnings over time.
//
// Uses the hosted Mem0 platform client (MEM0_API_KEY). All learnings are scoped to
// one user id so recall stays within this niche's analytics memory.
//
// These functions are raw (they throw on API error) — callers wrap them in
// harnessedCall() and treat them as best-effort, so a Mem0 outage never blocks the
// daily refresh. When MEM0_API_KEY is unset, Mem0 is simply disabled (no-op /
// empty), logged once, not treated as an error.

import { MemoryClient, type Message, type AddMemoryOptions } from "mem0ai";
import { NICHE } from "./constants.js";

const MEM0_USER_ID = `analytics:${NICHE}`;

let client: MemoryClient | null = null;
let disabled = false;

function getClient(): MemoryClient | null {
  if (disabled) return null;
  if (client) return client;
  const apiKey = process.env["MEM0_API_KEY"];
  if (!apiKey) {
    console.warn("[mem0] MEM0_API_KEY not set — qualitative memory disabled");
    disabled = true;
    return null;
  }
  client = new MemoryClient({ apiKey });
  return client;
}

export function mem0Enabled(): boolean {
  return getClient() !== null;
}

// Store a qualitative learning. No-op when Mem0 is disabled; throws on API error
// (caller wraps in harnessedCall and tolerates failure).
export async function addLearning(content: string, metadata?: Record<string, unknown>): Promise<void> {
  const c = getClient();
  if (!c) return;
  const messages: Message[] = [{ role: "assistant", content }];
  // infer:false → store the observation verbatim rather than re-deriving facts from it.
  const options: AddMemoryOptions = { userId: MEM0_USER_ID, infer: false };
  if (metadata) options.metadata = metadata;
  await c.add(messages, options);
}

// Recall semantically relevant learnings. Returns [] when disabled; throws on API
// error (caller wraps in harnessedCall and falls back to []).
export async function recallLearnings(query: string, limit = 5): Promise<string[]> {
  const c = getClient();
  if (!c) return [];
  // Platform search scopes by filters (not userId) — keep recall within this niche.
  const { results } = await c.search(query, { filters: { user_id: MEM0_USER_ID }, topK: limit });
  return results
    .map((m) => m.memory)
    .filter((m): m is string => typeof m === "string" && m.length > 0);
}

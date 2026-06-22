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
// Separate namespace for the per-meme posting log so a recall of "what did I post"
// never gets mixed in with the qualitative strategy learnings above.
const MEME_LOG_USER_ID = `memes:${NICHE}`;

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

// Record that a meme with the given template was posted. Persists the template in
// metadata so recall is exact (no parsing free text). No-op when Mem0 is disabled;
// throws on API error (caller wraps in harnessedCall and tolerates failure).
export async function rememberPostedMeme(
  template: string,
  topic: string,
  date = new Date().toISOString().slice(0, 10)
): Promise<void> {
  const c = getClient();
  if (!c) return;
  const messages: Message[] = [
    { role: "assistant", content: `Posted a meme using the "${template}" template (topic: ${topic}) on ${date}.` },
  ];
  await c.add(messages, {
    userId: MEME_LOG_USER_ID,
    infer: false, // store the record verbatim, don't re-derive facts
    metadata: { kind: "meme-post", template, topic, date },
  });
}

// Recall the templates used by the most recently posted memes, newest first and
// de-duplicated. Reads the template from each memory's metadata and orders by
// createdAt. Returns [] when Mem0 is disabled; throws on API error.
export async function recallRecentTemplates(limit = 8): Promise<string[]> {
  const c = getClient();
  if (!c) return [];
  // A stable query is fine — the user_id filter already scopes to the meme log; we
  // pull a generous topK and order by recency ourselves.
  const { results } = await c.search("meme templates recently posted", {
    filters: { user_id: MEME_LOG_USER_ID },
    topK: Math.max(limit * 3, 20),
  });

  const withTime = results
    .map((m) => ({
      template: (m.metadata as { template?: unknown } | null | undefined)?.template,
      createdAt: m.createdAt ? new Date(m.createdAt).getTime() : 0,
    }))
    .filter((r): r is { template: string; createdAt: number } => typeof r.template === "string");

  withTime.sort((a, b) => b.createdAt - a.createdAt);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of withTime) {
    if (seen.has(r.template)) continue;
    seen.add(r.template);
    out.push(r.template);
    if (out.length >= limit) break;
  }
  return out;
}

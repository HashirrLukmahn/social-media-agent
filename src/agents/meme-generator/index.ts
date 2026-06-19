// Meme Generator Agent
// Pure function: style context in, meme out.
// Knows nothing about Bluesky, scheduling, or analytics.

import { harnessedCall } from "../../harness/index.js";
import { kvGet, kvSet } from "../../harness/store.js";
import type { CreditBudget, FallbackMeme, GeneratedMeme, StyleLog } from "../../shared/types.js";
import { BLOCKED_TOPICS, NICHE, SAFETY_CONSTRAINTS } from "../../shared/constants.js";

const CREDIT_BUDGET_KEY = "credit_budget:today";
const STYLE_LOG_KEY = "style_log:today";
const FALLBACK_BANK_KEY = "fallback_bank";

interface MemelordResponse {
  imageUrl: string;
  templateUsed: string;
  caption: string;
}

async function callMemelord(prompt: string): Promise<MemelordResponse> {
  const res = await fetch("https://api.memelord.com/v1/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env["MEMELORD_API_KEY"]}`,
    },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(30_000), // 30s hard timeout per call
  });

  if (!res.ok) {
    throw new Error(`Memelord API ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<MemelordResponse>;
}

function buildPrompt(styleLog: StyleLog, topic: string): string {
  const formatGuidance = styleLog.formatNotes.length > 0
    ? `\nFormat guidance from past performance:\n${styleLog.formatNotes.map((n) => `- ${n}`).join("\n")}`
    : "";

  return `You are generating a software engineering humor meme for a Bluesky audience.

Niche: ${styleLog.niche}
Topic: ${topic}${formatGuidance}

${SAFETY_CONSTRAINTS}

Generate a meme with a short, punchy caption. Style: dry, absurdist, or relatable-pain humor.
Single-panel format preferred unless dialogue structure serves the joke better.
No setup/punchline labels — let the image carry the setup.`;
}

function selectTopic(styleLog: StyleLog): string {
  const safeCandidates = styleLog.topics.filter(
    (t) => !BLOCKED_TOPICS.some((b) => t.name.toLowerCase().includes(b))
  );

  if (safeCandidates.length === 0) {
    return "debugging mysteries";
  }

  // Explore/exploit: weight established > emerging > exploring.
  // Early on (few established topics), picks from all with equal weight.
  const weights = safeCandidates.map((t) => {
    if (t.confidence === "established") return t.avgScore + 0.5;
    if (t.confidence === "emerging") return t.avgScore + 0.2;
    return 0.1; // always keep some exploration weight
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let pick = Math.random() * total;
  for (let i = 0; i < safeCandidates.length; i++) {
    pick -= weights[i] ?? 0;
    if (pick <= 0) return safeCandidates[i]?.name ?? "debugging mysteries";
  }
  return safeCandidates[safeCandidates.length - 1]?.name ?? "debugging mysteries";
}

async function deductCredit(correlationId?: string): Promise<void> {
  const budget = await kvGet<CreditBudget>(CREDIT_BUDGET_KEY);
  if (!budget) {
    console.warn("[meme-generator] no credit budget found — skipping credit tracking");
    return;
  }
  if (budget.remaining <= 0) {
    throw new Error("Daily credit budget exhausted");
  }
  const updated: CreditBudget = {
    ...budget,
    spent: budget.spent + 1,
    remaining: budget.remaining - 1,
  };
  await kvSet(CREDIT_BUDGET_KEY, updated, 24 * 60 * 60);
}

async function getFallbackMeme(): Promise<GeneratedMeme | null> {
  const bank = await kvGet<FallbackMeme[]>(FALLBACK_BANK_KEY);
  if (!bank || bank.length === 0) return null;

  const meme = bank[Math.floor(Math.random() * bank.length)];
  if (!meme) return null;

  return {
    imageUrl: meme.imageUrl,
    caption: meme.caption,
    templateUsed: "fallback",
    creditsUsed: 0,
  };
}

export async function generate(slotId: string, correlationId?: string): Promise<GeneratedMeme> {
  const styleLog = await kvGet<StyleLog>(STYLE_LOG_KEY);
  if (!styleLog) {
    throw new Error("Style log not found in Redis — run daily refresh first");
  }

  const topic = selectTopic(styleLog);

  if (BLOCKED_TOPICS.some((b) => topic.toLowerCase().includes(b))) {
    throw new Error(`Topic "${topic}" is on the blocklist`);
  }

  const prompt = buildPrompt(styleLog, topic);

  try {
    const result = await harnessedCall(
      {
        agentName: "meme-generator",
        action: "generate-meme",
        input: { slotId, topic, prompt: prompt.slice(0, 200) },
        correlationId,
        attempts: 3,
        baseDelayMs: 1000,
      },
      () => callMemelord(prompt)
    );

    await deductCredit(correlationId);

    return {
      imageUrl: result.imageUrl,
      caption: result.caption,
      templateUsed: result.templateUsed,
      creditsUsed: 1,
    };
  } catch {
    console.warn("[meme-generator] generation failed, attempting fallback bank");
    const fallback = await getFallbackMeme();
    if (fallback) {
      console.info("[meme-generator] using fallback meme");
      return fallback;
    }
    throw new Error("Generation failed and fallback bank is empty — slot must be skipped");
  }
}

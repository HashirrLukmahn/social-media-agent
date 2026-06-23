// Style-seed extraction (§9 steps 1-2): scrape STYLE_SEED_ACCOUNTS via Apify, rank
// by engagement, and run a Claude style-extraction pass over the top performers to
// derive the initial style log. Used once by scripts/seed.ts.
//
// Degrades gracefully: if STYLE_SEED_ACCOUNTS is empty or the scrape/extraction
// fails, returns a generic fallback seed so setup can still complete (this is a
// one-time manual script, not the live loop).

import { harnessedCall } from "../harness/index.js";
import { completeText } from "../shared/llm.js";
import { scrapeInstagramPosts, engagement } from "../shared/instagram.js";
import type { StyleLog, StyleLogTopic } from "../shared/types.js";
import { NICHE } from "../shared/constants.js";
import { STYLE_SEED_ACCOUNTS } from "../shared/config.js";

const SEED_RESULTS_PER_ACCOUNT = 30; // §9: scrape ~20-30 reference memes per account
const TOP_N_FOR_EXTRACTION = 15; // §9 step 2: feed the top 10-15 performers into extraction

const EXTRACTION_SYSTEM = `You are setting up the style guide for an autonomous meme account whose concept blends software engineering, startup life/culture, and big-tech life/culture.

The user message lists top-performing reference posts (format type, engagement, caption) from accounts whose style is worth learning from. Derive a reusable style guide.

Produce:
- topics: 6-8 recurring topic/theme areas this account should explore (short labels, e.g. "debugging mysteries", "founder burnout")
- formatNotes: 3-5 notes on what makes these land — humor style (dry/absurdist/relatable-pain), caption structure (setup/punchline, single-line, dialogue), template patterns, tone
- audienceNotes: one sentence (<=40 words) describing who this resonates with

Derive the style from the patterns in the data — never copy literal captions.

Respond with ONLY valid JSON, no markdown:
{ "topics": ["..."], "formatNotes": ["..."], "audienceNotes": "..." }`;

// Generic fallback seed — used only when STYLE_SEED_ACCOUNTS is empty or the
// scrape/extraction fails, so the system can still boot. The real path derives
// these from scraped reference content.
const FALLBACK_TOPICS = [
  "debugging mysteries",
  "deployment anxiety",
  "code review pain",
  "interview performance",
  "legacy codebase",
  "documentation gaps",
  "standup theater",
];
const FALLBACK_FORMAT_NOTES = [
  "Single-panel captions perform well for relatable-pain topics",
  "Dry deadpan delivery lands better than over-explained setups",
  "Setup/punchline can be implicit — let the image carry context",
];

function newTopic(name: string, now: string): StyleLogTopic {
  return { name, timesGenerated: 0, avgScore: 0, confidence: "exploring", lastUsed: now };
}

function fallbackStyleLog(now: string): StyleLog {
  return {
    niche: NICHE,
    topics: FALLBACK_TOPICS.map((name) => newTopic(name, now)),
    formatNotes: FALLBACK_FORMAT_NOTES,
    audienceNotes: "",
    trendingThemes: [],
    blueskyTrendingThemes: [],
    currentEventsContext: [],
    publicSentimentTowardDevs: null,
    lastUpdated: now,
  };
}

export async function buildInitialStyleLog(): Promise<StyleLog> {
  const now = new Date().toISOString();

  if (STYLE_SEED_ACCOUNTS.length === 0) {
    console.warn(
      "[style-seed] STYLE_SEED_ACCOUNTS is empty — skipping scrape, using the generic fallback seed. " +
        "Populate STYLE_SEED_ACCOUNTS in src/shared/config.ts and re-run for a data-derived style log."
    );
    return fallbackStyleLog(now);
  }

  try {
    const posts = await harnessedCall(
      {
        agentName: "analytics",
        action: "apify-style-seed-scrape",
        input: { accountCount: STYLE_SEED_ACCOUNTS.length },
        skipCircuitBreaker: true,
      },
      () => scrapeInstagramPosts({ handles: STYLE_SEED_ACCOUNTS, resultsLimit: SEED_RESULTS_PER_ACCOUNT })
    );

    if (posts.length === 0) {
      console.warn("[style-seed] scrape returned no posts — using the generic fallback seed");
      return fallbackStyleLog(now);
    }

    const top = [...posts].sort((a, b) => engagement(b) - engagement(a)).slice(0, TOP_N_FOR_EXTRACTION);
    const lines = top
      .map(
        (p, i) =>
          `${i + 1}. [${p.type ?? "Post"}] (${engagement(p)} eng) by @${p.ownerUsername ?? "?"}: ${(p.caption ?? "").slice(0, 300).replace(/\s+/g, " ")}`
      )
      .join("\n");

    const text = await harnessedCall(
      {
        agentName: "analytics",
        action: "extract-style-seed",
        input: { postsConsidered: top.length },
        skipCircuitBreaker: true,
      },
      () => completeText({ system: EXTRACTION_SYSTEM, user: lines, maxTokens: 1024 })
    );

    const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(clean) as {
      topics?: unknown;
      formatNotes?: unknown;
      audienceNotes?: unknown;
    };

    const topics = (Array.isArray(parsed.topics) ? parsed.topics : []).filter(
      (t): t is string => typeof t === "string"
    );
    const formatNotes = (Array.isArray(parsed.formatNotes) ? parsed.formatNotes : []).filter(
      (n): n is string => typeof n === "string"
    );
    const audienceNotes = typeof parsed.audienceNotes === "string" ? parsed.audienceNotes : "";

    if (topics.length === 0) {
      console.warn("[style-seed] extraction produced no usable topics — using the generic fallback seed");
      return fallbackStyleLog(now);
    }

    console.info(
      `[style-seed] derived style log from ${posts.length} scraped posts: ${topics.length} topics, ${formatNotes.length} format notes`
    );
    return {
      niche: NICHE,
      topics: topics.map((name) => newTopic(name, now)),
      formatNotes: formatNotes.length > 0 ? formatNotes : FALLBACK_FORMAT_NOTES,
      audienceNotes,
      trendingThemes: [],
      blueskyTrendingThemes: [],
      currentEventsContext: [],
      publicSentimentTowardDevs: null,
      lastUpdated: now,
    };
  } catch (err) {
    console.warn(
      "[style-seed] style extraction failed, using the generic fallback seed:",
      err instanceof Error ? err.message : err
    );
    return fallbackStyleLog(now);
  }
}

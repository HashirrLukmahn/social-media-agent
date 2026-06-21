// Daily trending-themes job (§3.7 step 1).
//
// Pulls recent reels/posts from TRENDING_THEMES_ACCOUNTS via the general Apify
// Instagram scraper (apify/instagram-scraper — handles image/video/carousel/reel
// and tags each with its type), then uses Claude (Haiku) to abstract the top
// performers into 3-5 theme-level bullets.
//
// ORIGINALITY (§3.7): the abstraction pass must emit themes/formats ONLY — never
// the literal scraped captions. We post original takes inspired by what's
// trending, not copies.
//
// This returns string[] and never throws: an empty config array, an Apify error,
// or a model error all resolve to [] so runDailyRefresh() is never blocked.

import { harnessedCall } from "../harness/index.js";
import { completeText } from "../shared/llm.js";
import { scrapeInstagramPosts, engagement, type InstagramPost } from "../shared/instagram.js";
import { TRENDING_THEMES_ACCOUNTS } from "../shared/config.js";

const LOOKBACK = "2 days"; // §3.7: last 24-48hrs
const RESULTS_PER_ACCOUNT = 20; // pulled per account, then sorted by engagement
const TOP_N_FOR_ABSTRACTION = 8; // top performers fed to the model (spec: 5-10)

async function scrapeRecentPosts(correlationId?: string): Promise<InstagramPost[]> {
  return harnessedCall(
    {
      agentName: "analytics",
      action: "apify-trending-scrape",
      input: { accountCount: TRENDING_THEMES_ACCOUNTS.length, lookback: LOOKBACK },
      correlationId,
      skipCircuitBreaker: true, // read-only enrichment; failing open is fine
    },
    () =>
      scrapeInstagramPosts({
        handles: TRENDING_THEMES_ACCOUNTS,
        resultsLimit: RESULTS_PER_ACCOUNT,
        onlyPostsNewerThan: LOOKBACK,
      })
  );
}

async function abstractThemes(
  posts: InstagramPost[],
  correlationId?: string
): Promise<string[]> {
  const top = [...posts].sort((a, b) => engagement(b) - engagement(a)).slice(0, TOP_N_FOR_ABSTRACTION);

  const lines = top
    .map(
      (p, i) =>
        `${i + 1}. [${p.type ?? "Post"}] (${engagement(p)} eng) by @${p.ownerUsername ?? "?"}: ${(p.caption ?? "").slice(0, 200).replace(/\s+/g, " ")}`
    )
    .join("\n");

  const system = `You are a content strategist for an autonomous meme account whose concept blends software engineering, startup life/culture, and big-tech life/culture.

The user message lists top-performing recent posts from reference meme accounts (with format type and engagement). Identify 3-5 TRENDING THEMES or FORMATS worth riffing on over the next day.

STRICT RULES:
- Output themes and format patterns ONLY — never reproduce or lightly reword any literal caption in the input. We make original takes, not copies.
- Each bullet = a generalized theme/angle (e.g. "the 'it works on my machine' deflection", "founder-mode burnout jokes") or a format pattern (e.g. "two-panel expectation vs reality").
- Keep each bullet under 15 words. No numbering, no commentary.

Respond with ONLY valid JSON, no markdown:
{ "themes": ["...", "..."] }`;

  return harnessedCall(
    {
      agentName: "analytics",
      action: "abstract-trending-themes",
      input: { postsConsidered: top.length },
      correlationId,
      skipCircuitBreaker: true,
    },
    async () => {
      const text = await completeText({ system, user: lines, maxTokens: 512 });
      const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

      let parsed: { themes?: unknown };
      try {
        parsed = JSON.parse(clean) as { themes?: unknown };
      } catch {
        console.warn("[trending-themes] could not parse model response — returning no themes");
        return [];
      }
      return Array.isArray(parsed.themes)
        ? (parsed.themes as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
    }
  );
}

// Entry point used by runDailyRefresh(). Always resolves (never throws): returns
// [] on empty config, scrape failure, or abstraction failure.
export async function fetchTrendingThemes(correlationId?: string): Promise<string[]> {
  if (TRENDING_THEMES_ACCOUNTS.length === 0) {
    console.info("[trending-themes] TRENDING_THEMES_ACCOUNTS is empty — skipping scrape, writing no themes");
    return [];
  }

  try {
    const posts = await scrapeRecentPosts(correlationId);
    if (posts.length === 0) {
      console.info("[trending-themes] scrape returned no recent posts — writing no themes");
      return [];
    }
    const themes = await abstractThemes(posts, correlationId);
    console.info(`[trending-themes] derived ${themes.length} themes from ${posts.length} scraped posts`);
    return themes;
  } catch (err) {
    console.warn(
      "[trending-themes] failed, continuing refresh with no themes:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

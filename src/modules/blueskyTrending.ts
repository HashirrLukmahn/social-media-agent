// Daily Bluesky trending-memes job (Feature 3).
//
// SUPPLEMENTS (does not replace) the Instagram Apify trending-themes pull and the
// Anthropic web-search job. Once per day, search Bluesky's OWN public API for the
// top-performing niche posts in the last 24hrs — no scraping, no Apify, this is the
// target platform's own data via @atproto/api — then abstract the top performers
// into theme-level observations.
//
// ORIGINALITY (same rule as the Instagram pull): the abstraction emits themes /
// joke structures / tones ONLY, never literal captions.
//
// Returns string[] and never throws: a search error or a model error both resolve
// to [] so runDailyRefresh() is never blocked.

import { harnessedCall } from "../harness/index.js";
import { completeText } from "../shared/llm.js";
import { getBskyAgent } from "./socialMedia.js";
import { NICHE_HASHTAGS } from "../shared/constants.js";

const MIN_LIKES = 5; // filter: keep posts with >= this many likes ...
const MIN_REPOSTS = 2; // ... OR this many reposts
const TOP_N_FOR_ABSTRACTION = 10; // captions fed to the model (spec: top 10)

interface TopPost {
  text: string;
  likeCount: number;
  repostCount: number;
}

// Pull recent niche posts ranked by Bluesky's own "top" sort, then keep only the
// ones with real traction.
async function fetchTopPosts(correlationId?: string): Promise<TopPost[]> {
  const query = NICHE_HASHTAGS.join(" OR ");
  return harnessedCall(
    {
      agentName: "analytics",
      action: "bluesky-trending-search",
      input: { query },
      correlationId,
      skipCircuitBreaker: true, // read-only enrichment; failing open is fine
    },
    async () => {
      const agent = await getBskyAgent();
      const { data } = await agent.app.bsky.feed.searchPosts({
        q: query,
        limit: 20,
        sort: "top",
      });

      const posts: TopPost[] = [];
      for (const raw of data.posts) {
        const p = raw as {
          record?: { text?: string };
          likeCount?: number;
          repostCount?: number;
        };
        const text = typeof p.record?.text === "string" ? p.record.text : "";
        const likeCount = typeof p.likeCount === "number" ? p.likeCount : 0;
        const repostCount = typeof p.repostCount === "number" ? p.repostCount : 0;
        if (!text) continue;
        if (likeCount >= MIN_LIKES || repostCount >= MIN_REPOSTS) {
          posts.push({ text, likeCount, repostCount });
        }
      }
      return posts;
    }
  );
}

async function abstractThemes(posts: TopPost[], correlationId?: string): Promise<string[]> {
  const top = [...posts]
    .sort((a, b) => b.likeCount + b.repostCount * 3 - (a.likeCount + a.repostCount * 3))
    .slice(0, TOP_N_FOR_ABSTRACTION);

  const captions = top
    .map((p, i) => `${i + 1}. (${p.likeCount} likes, ${p.repostCount} reposts) ${p.text.slice(0, 200).replace(/\s+/g, " ")}`)
    .join("\n");

  const system = `These are the top-performing software engineering memes on Bluesky today. Extract 3-5 theme-level observations about what's resonating — what topics, joke structures, and emotional tones are landing with this audience. Be specific about format (e.g. 'self-deprecating deployment fear', 'dry one-liners about PRs') not just topics. Return a JSON array of strings only.`;

  return harnessedCall(
    {
      agentName: "analytics",
      action: "abstract-bluesky-trending",
      input: { postsConsidered: top.length },
      correlationId,
      skipCircuitBreaker: true,
    },
    async () => {
      const text = await completeText({ system, user: captions, maxTokens: 512 });
      const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

      let parsed: unknown;
      try {
        parsed = JSON.parse(clean);
      } catch {
        console.warn("[bluesky-trending] could not parse model response — returning no themes");
        return [];
      }
      return Array.isArray(parsed)
        ? parsed.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        : [];
    }
  );
}

// Entry point used by runDailyRefresh(). Always resolves (never throws): returns []
// on search failure or abstraction failure so the rest of the refresh continues.
export async function fetchBlueskyTrendingThemes(correlationId?: string): Promise<string[]> {
  try {
    const posts = await fetchTopPosts(correlationId);
    if (posts.length === 0) {
      console.info("[bluesky-trending] no high-traction niche posts today — writing no themes");
      return [];
    }
    const themes = await abstractThemes(posts, correlationId);
    console.info(`[bluesky-trending] derived ${themes.length} themes from ${posts.length} top Bluesky posts`);
    return themes;
  } catch (err) {
    console.warn(
      "[bluesky-trending] failed, continuing refresh with no themes:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

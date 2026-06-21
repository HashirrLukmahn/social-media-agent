// Shared Apify Instagram scraping used by both the daily trending-themes job
// (§3.7 step 1) and the one-time style seed (§9 step 1).
//
// Uses the general apify/instagram-scraper, which handles image/video/carousel/reel
// posts and tags each with its `type` — unlike the reel-only actor, it also returns
// the static image posts that make up most reference meme content.
//
// This is the raw scrape only; callers wrap it in harnessedCall() with their own
// action label so it inherits kill-switch / circuit-breaker / retry / logging.

import { ApifyClient } from "apify-client";

const APIFY_INSTAGRAM_ACTOR = "apify/instagram-scraper";

// Minimal shape of the scraper output items we care about.
export interface InstagramPost {
  type?: string;
  caption?: string;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  ownerUsername?: string;
  url?: string;
}

let apify: ApifyClient | null = null;
function getApify(): ApifyClient {
  if (apify) return apify;
  apify = new ApifyClient({ token: process.env["APIFY_API_KEY"] ?? "" });
  return apify;
}

// Engagement proxy used for ranking — likes + comments (the actor has no native
// "sort by engagement" input, so callers sort client-side).
export function engagement(p: InstagramPost): number {
  return (p.likesCount ?? 0) + (p.commentsCount ?? 0);
}

// `handles` accepts Instagram usernames (with or without a leading @) or full
// profile/post/reel URLs — each is processed individually by the actor.
export async function scrapeInstagramPosts(opts: {
  handles: string[];
  resultsLimit: number;
  onlyPostsNewerThan?: string;
}): Promise<InstagramPost[]> {
  const directUrls = opts.handles.map((h) => {
    const trimmed = h.trim();
    return trimmed.startsWith("http")
      ? trimmed
      : `https://www.instagram.com/${trimmed.replace(/^@/, "")}/`;
  });

  const input: Record<string, unknown> = {
    directUrls,
    resultsType: "posts",
    resultsLimit: opts.resultsLimit,
    addParentData: false,
  };
  if (opts.onlyPostsNewerThan) input["onlyPostsNewerThan"] = opts.onlyPostsNewerThan;

  const client = getApify();
  const run = await client.actor(APIFY_INSTAGRAM_ACTOR).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items as unknown as InstagramPost[];
}

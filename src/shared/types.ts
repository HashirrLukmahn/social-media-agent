// Redis key: "style_log:today"  — TTL 24hr, written once/day by dailyRefresh
export interface StyleLogTopic {
  name: string;
  timesGenerated: number;
  avgScore: number;
  confidence: "exploring" | "emerging" | "established";
  lastUsed: string;
}

// Tone-calibration signal from the daily web-search call (§3.7 step 2). NOT a topic
// source — it tells the Meme Generator *how* to joke, not what about. null when no
// notable signal that day.
export interface PublicSentiment {
  tone: "hostile" | "neutral" | "sympathetic";
  reason: string;
}

export interface StyleLog {
  niche: string;
  topics: StyleLogTopic[];
  formatNotes: string[];
  // LLM-synthesized audience description — updated daily by analytics synthesis.
  // Starts empty; grows more specific as real performance data accumulates.
  audienceNotes: string;
  // Abstracted theme bullets from the daily Apify trending-themes scrape (§3.7 step 1).
  // Themes/formats only, never literal scraped captions. Empty when the scrape is
  // skipped (empty account list) or fails — never blocks the rest of the refresh.
  trendingThemes: string[];
  // Abstracted theme bullets from the daily Bluesky top-memes scrape (Feature 3) —
  // what's resonating on the TARGET platform's own feed (topics, joke structures,
  // tones). Supplements trendingThemes (which comes from Instagram). Empty when the
  // search returns nothing or fails — never blocks the rest of the refresh.
  blueskyTrendingThemes: string[];
  // Short current-events bullets from the daily Claude web-search call (§3.7 step 2):
  // today's tech/startup/big-tech news plus any major live cultural event. Empty when
  // the call fails — never blocks the rest of the refresh. Optional topic inspiration.
  currentEventsContext: string[];
  // Public mood toward developers/tech workers, from the same web-search call (§3.7
  // step 2). A tone modifier (hostile → lean self-deprecating), not a topic. null when
  // nothing notable surfaces or the call fails — treat null as "no adjustment".
  publicSentimentTowardDevs: PublicSentiment | null;
  lastUpdated: string;
}

// Redis key: "generation_cap:today"  — TTL 24hr, written once/day by dailyRefresh.
// Replaces the old Memelord credit budget (§4): a self-imposed pacing count, not a
// spend budget, since Memegen.link is free and Magic Hour is exploratory-only.
export interface GenerationCap {
  date: string;
  mandatory: number;   // 3 — always generated, one per scheduled post
  exploratory: number; // up to 5 — creative/test generations
  used: number;        // total generations today, both types combined
}

// Redis key: "fallback_bank"  — persistent, non-TTL
export interface FallbackMeme {
  id: string;
  imageUrl: string;
  caption: string;
  approvedAt: string;
}

export interface GeneratedMeme {
  imageUrl: string;
  caption: string;
  templateUsed: string;
  // Which path produced this meme — replaces the old creditsUsed count.
  generator: "memegen" | "magichour" | "fallback";
  topic: string;
  // Why the agent chose this template/joke (1-2 sentences). Surfaced to Slack on
  // post so a human can see the reasoning and spot when formats get repetitive.
  reasoning: string;
  // The specific style inputs the agent drew on (trending themes, current events,
  // audience/format notes). Empty when it leaned only on the base topic.
  themesReferenced: string[];
  // Topic-tailored hashtags chosen for this post. Falls back to DEFAULT_HASHTAGS
  // when the model returns none.
  hashtags: string[];
}

export interface RawEngagementMetrics {
  slotId: string;
  checkpoint: "1hr" | "6hr" | "24hr";
  likes: number;
  reposts: number;
  replies: number;
  views: number;
  followerDelta: number;
  blueskyUri: string;
}

// Which generation path a scheduled post should use. "fallback" is not schedulable —
// it's only ever a runtime degradation of one of these two.
export type Generator = "memegen" | "magichour";

export interface PostingSlot {
  slotId: string;
  windowIndex: 0 | 1 | 2;
  // The generator this specific post should use. A window may have multiple slots
  // (e.g. a Memegen post AND a Magic Hour post — the "double-up" layout).
  generator: Generator;
  scheduledAt: Date;
  correlationId: string;
}

// Persistent Redis key: "posting_plan" (no TTL). Rewritten daily by the analytics
// posting-plan synthesis (full autonomy) and read by the scheduler when it builds
// each day's schedule. generatorsByWindow[i] is the ordered list of posts to make in
// POSTING_WINDOWS[i] — one entry per post, naming its generator. An empty inner array
// means that window is skipped that day. Default layout: 3 Memegen + 2 Magic Hour.
export interface PostingPlan {
  generatorsByWindow: Generator[][];
  // 1-2 sentence explanation of why the analysis chose this layout — for observability.
  rationale: string;
  updatedAt: string;
}

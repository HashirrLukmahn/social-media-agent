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

export interface PostingSlot {
  slotId: string;
  windowIndex: 0 | 1 | 2;
  scheduledAt: Date;
  correlationId: string;
}

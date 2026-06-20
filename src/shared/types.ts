// Redis key: "style_log:today"  — TTL 24hr, written once/day by dailyRefresh
export interface StyleLogTopic {
  name: string;
  timesGenerated: number;
  avgScore: number;
  confidence: "exploring" | "emerging" | "established";
  lastUsed: string;
}

export interface StyleLog {
  niche: string;
  topics: StyleLogTopic[];
  formatNotes: string[];
  // LLM-synthesized audience description — updated daily by analytics synthesis.
  // Starts empty; grows more specific as real performance data accumulates.
  audienceNotes: string;
  lastUpdated: string;
}

// Redis key: "credit_budget:today"  — TTL 24hr, written once/day by dailyRefresh
export interface CreditBudget {
  date: string;
  totalAllotted: number;
  scheduledPosts: number;
  exploration: number;
  buffer: number;
  spent: number;
  remaining: number;
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
  creditsUsed: number;
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

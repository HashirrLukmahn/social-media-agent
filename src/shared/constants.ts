// Niche config — change NICHE env var to pivot (§1 of spec).
export const NICHE = process.env["NICHE"] ?? "software-engineering";

// Topics that must never be selected for generation, regardless of style log.
// NOTE: "layoffs"/"firing" were removed — layoff / "replaced by AI" humor is a core
// part of this account's niche. It's still constrained by SAFETY_CONSTRAINTS to stay
// self-deprecating and in-on-the-joke (never mocking people actually affected).
export const BLOCKED_TOPICS: readonly string[] = [
  "immigrants",
  "politics",
  "religion",
  "mental health",
  "suicide",
  "gender",
];

// Bluesky posting windows in UTC (EST = UTC-5, EDT = UTC-4).
// Windows are anchored to Bluesky's actual peak engagement hours.
// Each entry is [windowOpenHourUTC, windowCloseHourUTC, windowOpenMinUTC, windowCloseMinUTC].
export const POSTING_WINDOWS: ReadonlyArray<{ openH: number; openM: number; closeH: number; closeM: number }> = [
  { openH: 14, openM: 0, closeH: 15, closeM: 30 }, // 9:00–10:30 AM EST
  { openH: 17, openM: 0, closeH: 18, closeM: 30 }, // 12:00–1:30 PM EST
  { openH: 23, openM: 0, closeH: 0,  closeM: 30 }, // 6:00–7:30 PM EST (spans midnight UTC)
];

// Daily generation pacing cap (§4 — replaces the old Memelord credit budget).
// Memegen.link is free and Magic Hour is exploratory-only, so this is a simple
// self-imposed count, not a spend budget. 3 mandatory (one per scheduled post)
// + up to 5 exploratory = 8 generations/day max.
export const MANDATORY_GENERATIONS = 3;
export const EXPLORATORY_GENERATIONS = 5;

// Bluesky hashtags for discovery. Tune based on style log engagement data.
export const DEFAULT_HASHTAGS = ["#softwareengineering", "#devhumor", "#buildinpublic"] as const;

// Niche hashtags used to discover follow/like candidates (Features 1 & 2) and to
// scrape Bluesky's own top memes (Feature 3). Broader than DEFAULT_HASHTAGS so the
// search surfaces more of the community, not just our own posting tags.
export const NICHE_HASHTAGS = [
  "#softwareengineering",
  "#devhumor",
  "#buildinpublic",
  "#ProgrammerHumor",
] as const;

// Daily growth-engagement caps (Features 1 & 2). Stored in Redis as follows_today /
// likes_today (TTL 24hr), checked before every follow/like action.
export const FOLLOW_DAILY_CAP = 20;
export const LIKE_DAILY_CAP = 50;

// Random spacing between growth actions, in seconds — never act in a rapid burst.
// Follows are spaced wider than likes (a follow is a stronger, more visible signal).
export const FOLLOW_DELAY_SECONDS = { min: 30, max: 90 } as const;
export const LIKE_DELAY_SECONDS = { min: 10, max: 30 } as const;

// Engagement signal thresholds for like candidates (Feature 2): a post must clear
// one of these to be considered "genuinely good", not just any post in the feed.
export const LIKE_MIN_REPOSTS = 1;
export const LIKE_MIN_LIKES = 3;

// Minimum times an account must appear in the niche-hashtag search to be a follow
// candidate (Feature 1) — filters out one-off / drive-by posters.
export const FOLLOW_MIN_NICHE_POSTS = 2;

// Safety constraints baked into every meme-generation request (§6 layer 1).
export const SAFETY_CONSTRAINTS = `
NEVER generate content that:
- Targets any nationality, ethnicity, gender, or religion
- Makes light of mental health, self-harm, or serious personal/financial ruin
- References real named individuals
- Is politically charged in any direction
- Punches down at people genuinely struggling — layoff and "replaced by AI" humor is
  fine but must stay self-deprecating and in-on-the-joke, never mocking those affected
`.trim();

// Confidence tier thresholds (§4.1 of spec).
export const EMERGING_MIN_POSTS = 3;
export const ESTABLISHED_MIN_POSTS = 6;

// Engagement scoring weights (§4.1 of spec).
export const SCORE_WEIGHTS = {
  repost: 3,
  like: 1,
  sentimentAdjustedReply: 1.5,
} as const;

// Reply engagement cap per cycle (§7 of spec).
export const MAX_REPLIES_PER_CYCLE = 10;

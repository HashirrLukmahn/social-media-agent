// Niche config — change NICHE env var to pivot (§1 of spec).
export const NICHE = process.env["NICHE"] ?? "software-engineering";

// Topics that must never be selected for generation, regardless of style log.
export const BLOCKED_TOPICS: readonly string[] = [
  "layoffs",
  "firing",
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

export const DAILY_CREDIT_LIMIT = 20;
export const CREDIT_SCHEDULED_POSTS = 3;
export const CREDIT_EXPLORATION_BUDGET = 5;

// Bluesky hashtags for discovery. Tune based on style log engagement data.
export const DEFAULT_HASHTAGS = ["#softwareengineering", "#devhumor", "#buildinpublic"] as const;

// Memelord prompt safety constraints baked into every generation request.
export const SAFETY_CONSTRAINTS = `
NEVER generate content that:
- Targets any nationality, ethnicity, gender, or religion
- Makes light of mental health, job loss, or financial hardship
- References real named individuals
- Is politically charged in any direction
- Punches down at junior developers or beginners
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

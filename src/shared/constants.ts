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

// Account configuration for the Apify-backed jobs (§2.1 of spec).
//
// These are intentionally empty by default. Fill in real Instagram handles
// (without the leading @) before running the relevant job:
//
//   STYLE_SEED_ACCOUNTS     — used once by the style-seed script (§9, npm run seed)
//                             to derive the initial style log from reference reels.
//   TRENDING_THEMES_ACCOUNTS — used daily by runDailyRefresh() (§3.7 step 1) to
//                             pull recent reels and abstract trending themes.
//
// Both downstream jobs MUST treat an empty array as "skip the scrape": log it,
// write an empty result, and never crash. See dailyRefresh.ts (trending themes)
// and scripts/seed.ts (style seed).
export const STYLE_SEED_ACCOUNTS: string[] = [];
export const TRENDING_THEMES_ACCOUNTS: string[] = [];

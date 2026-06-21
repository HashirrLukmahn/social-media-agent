// Account configuration for the Apify-backed jobs (§2.1 of spec).
//
// Instagram handles (without the leading @) or full profile/post URLs:
//
//   STYLE_SEED_ACCOUNTS     — used once by the style-seed script (§9, npm run seed)
//                             to derive the initial style log from reference posts.
//                             Accepts profile handles AND individual post URLs.
//   TRENDING_THEMES_ACCOUNTS — used daily by runDailyRefresh() (§3.7 step 1) to
//                             pull recent posts and abstract trending themes.
//   SEED_TOPICS             — content topics the bot should cover from day one.
//                             Merged into the style log by runDailyRefresh(); the
//                             analytics loop then promotes/demotes by real engagement.
//
// The account/post lists treat an empty array as "skip the scrape": log it, write
// an empty result, and never crash. See dailyRefresh.ts and scripts/seed.ts.

// Curated reference accounts (humor + format) and hand-picked reference posts.
const SEED_ACCOUNT_HANDLES: string[] = [
  "mcspicy.sg",
  "jessvalortiz",
  "jackbgreenberg",
  "joob4ca",
  "techroastshow",
  "fentifriedchicken",
  "mengmengduck",
  "growithadi_",
  "therobdon567",
  "softcatmemes",
  "moistbuddha",
  "fboy",
  "fomocapital",
  "hookedon.code",
  "desh.group",
  "cats_lifex0",
  "codedatt",
];

// Hand-picked individual reference posts (passed straight through to the scraper).
const SEED_POST_URLS: string[] = [
  "https://www.instagram.com/p/DVRPkiGCRCq/",
  "https://www.instagram.com/p/DU1R0KVkfZU/",
  "https://www.instagram.com/p/DYvkXE_NYOO/",
  "https://www.instagram.com/p/DXBZT0oEq-6/",
  "https://www.instagram.com/p/DUbL8P3gX1I/",
  "https://www.instagram.com/p/DULtwWikSTA/",
  "https://www.instagram.com/p/DQlIM5EEaOM/",
  "https://www.instagram.com/p/DQt50AMEWYz/",
  "https://www.instagram.com/p/DMszbHbT_Tk/",
  "https://www.instagram.com/p/DOZF6NcgSah/",
  "https://www.instagram.com/p/DKIDF6WJibn/",
  "https://www.instagram.com/p/DJpLFiYpFuC/",
  "https://www.instagram.com/p/DBurcq2ufE5/",
  "https://www.instagram.com/p/DGKF36hpNBN/",
  "https://www.instagram.com/p/DZxfTv_hiCn/",
  "https://www.instagram.com/p/DZveO1GSj6u/",
  "https://www.instagram.com/p/DCeFNhmR3Hz/",
  "https://www.instagram.com/p/DBJrQgSy-dc/",
  "https://www.instagram.com/p/DBOq-1jI59H/",
  "https://www.instagram.com/p/DAw2cVByYWl/",
  "https://www.instagram.com/p/DAmwFo_NRUe/",
  "https://www.instagram.com/p/C-Tz2UhAqHX/",
  "https://www.instagram.com/p/C6zj2VigxzZ/",
  "https://www.instagram.com/p/C8M1UjYttG8/",
  "https://www.instagram.com/p/DVEhMJEgKTG/",
  "https://www.instagram.com/p/DTxuhM-Dsoq/",
  "https://www.instagram.com/p/DWPAm2Lj7Kn/",
  "https://www.instagram.com/p/DGjlVJSPHZU/",
  "https://www.instagram.com/p/DBJp546RJJO/",
  "https://www.instagram.com/p/DBO6tTDP5k_/",
  "https://www.instagram.com/p/C6sYnXwy7Y1/",
  "https://www.instagram.com/p/C5p33_ostcO/",
  "https://www.instagram.com/p/C3atFhaOh3a/",
  "https://www.instagram.com/p/C4UV77xMxev/",
  "https://www.instagram.com/p/C4FidOUOyc0/",
  "https://www.instagram.com/p/C33I4jFP2i5/",
  "https://www.instagram.com/p/C3oPZNlCwVi/",
  "https://www.instagram.com/p/C35k58dCrsy/",
  "https://www.instagram.com/p/C04CIdcPdXw/",
  "https://www.instagram.com/p/CtNL4EBJ8A8/",
];

// Style seed = reference accounts + the hand-picked posts (richer signal for the
// one-time style extraction).
export const STYLE_SEED_ACCOUNTS: string[] = [...SEED_ACCOUNT_HANDLES, ...SEED_POST_URLS];

// Daily trending-theme scrape pulls from the reference accounts' recent posts.
export const TRENDING_THEMES_ACCOUNTS: string[] = [...SEED_ACCOUNT_HANDLES];

// Content topics the bot should cover from day one (merged into the style log by
// runDailyRefresh). Kept short and label-like; the meme generator weights them by
// learned engagement once data accumulates.
export const SEED_TOPICS: string[] = [
  "AI startups",
  "vibe coders",
  "the AI bubble popping",
  "big tech culture",
  "tech layoffs",
  "the useless CS degree",
  "losing your job to clankers (AI)",
  "B2B SaaS life",
  "programmer humor",
  "tech reels culture",
  "startup memes",
  "programming humor",
];

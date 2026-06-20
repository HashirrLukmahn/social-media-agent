// One-time setup seed script (§9 of spec).
// Run once before go-live. Not part of normal operation.
//
// Usage: npm run seed
//
// What it does:
//   1. Writes the initial style log to Postgres style_log_history
//   2. Runs the daily refresh to populate Redis from it
//   3. Writes 3 fallback bank memes to Redis
//   4. Verifies kill_switch is set to false (system live)

import { insertStyleLogHistory } from "../harness/db.js";
import { kvSet, kvGet } from "../harness/store.js";
import { runDailyRefresh } from "../shared/dailyRefresh.js";
import { v4 as uuidv4 } from "uuid";
import type { FallbackMeme, StyleLog } from "../shared/types.js";
import { NICHE } from "../shared/constants.js";
import type { KillSwitchState } from "../harness/types.js";

// Initial style log based on style-guide extraction from reference memes.
// Populate this via the Apify scraping + Gemini extraction pipeline from §9.
const INITIAL_STYLE_LOG: StyleLog = {
  niche: NICHE,
  topics: [
    {
      name: "debugging mysteries",
      timesGenerated: 0,
      avgScore: 0,
      confidence: "exploring",
      lastUsed: new Date().toISOString(),
    },
    {
      name: "deployment anxiety",
      timesGenerated: 0,
      avgScore: 0,
      confidence: "exploring",
      lastUsed: new Date().toISOString(),
    },
    {
      name: "code review pain",
      timesGenerated: 0,
      avgScore: 0,
      confidence: "exploring",
      lastUsed: new Date().toISOString(),
    },
    {
      name: "interview performance",
      timesGenerated: 0,
      avgScore: 0,
      confidence: "exploring",
      lastUsed: new Date().toISOString(),
    },
    {
      name: "legacy codebase",
      timesGenerated: 0,
      avgScore: 0,
      confidence: "exploring",
      lastUsed: new Date().toISOString(),
    },
    {
      name: "documentation gaps",
      timesGenerated: 0,
      avgScore: 0,
      confidence: "exploring",
      lastUsed: new Date().toISOString(),
    },
    {
      name: "standup theater",
      timesGenerated: 0,
      avgScore: 0,
      confidence: "exploring",
      lastUsed: new Date().toISOString(),
    },
  ],
  audienceNotes: "",
  formatNotes: [
    "Single-panel captions perform well for relatable-pain topics",
    "Dry deadpan delivery lands better than over-explained setups",
    "Setup/punchline can be implicit — let the image carry context",
  ],
  lastUpdated: new Date().toISOString(),
};

// Pre-approved evergreen fallback memes — replace URLs with real Memelord-generated
// images created and manually reviewed before go-live.
const FALLBACK_BANK: FallbackMeme[] = [
  {
    id: uuidv4(),
    imageUrl: "https://example.com/fallback-1.png", // replace before go-live
    caption: "When the bug fixes itself in production and you'll never know why #devhumor",
    approvedAt: new Date().toISOString(),
  },
  {
    id: uuidv4(),
    imageUrl: "https://example.com/fallback-2.png", // replace before go-live
    caption: "It's not a bug, it's undocumented behavior from 2014 #softwareengineering",
    approvedAt: new Date().toISOString(),
  },
  {
    id: uuidv4(),
    imageUrl: "https://example.com/fallback-3.png", // replace before go-live
    caption: "The pull request that started as a one-liner #buildinpublic",
    approvedAt: new Date().toISOString(),
  },
];

async function main(): Promise<void> {
  console.info("[seed] starting one-time setup...");

  // Step 1: write initial style log to Postgres
  await insertStyleLogHistory(NICHE, uuidv4(), INITIAL_STYLE_LOG);
  console.info("[seed] initial style log written to Postgres");

  // Step 2: run daily refresh to populate Redis from Postgres
  await runDailyRefresh();
  console.info("[seed] Redis daily cache populated");

  // Step 3: write fallback bank to Redis (persistent, non-TTL)
  await kvSet("fallback_bank", FALLBACK_BANK);
  console.info(`[seed] fallback bank seeded with ${FALLBACK_BANK.length} memes`);

  // Step 4: verify kill switch
  const killSwitch = await kvGet<KillSwitchState>("kill_switch");
  if (killSwitch?.paused) {
    console.warn("[seed] kill_switch is currently paused — set it to false when ready to go live");
  } else {
    // Set explicitly to false (not-paused = system live)
    await kvSet("kill_switch", { paused: false });
    console.info("[seed] kill_switch set to false — system is live");
  }

  console.info("[seed] setup complete. Next steps:");
  console.info("  1. Replace fallback_bank image URLs with real reviewed memes");
  console.info("  2. Write and post the account bio + pinned post manually (§5 of spec)");
  console.info("  3. Deploy all 4 Railway processes");
}

main().catch((err) => {
  console.error("[seed] setup failed:", err);
  process.exit(1);
});

// One-time setup seed script (§9 of spec).
// Run once before go-live. Not part of normal operation.
//
// Usage: npm run seed
//
// What it does:
//   1. Builds the initial style log via buildInitialStyleLog() — scrapes
//      STYLE_SEED_ACCOUNTS (Apify) + runs a Claude style-extraction pass (§9
//      steps 1-2), with a generic fallback if accounts are unset or it fails —
//      then writes it to Postgres style_log_history.
//   2. Runs the daily refresh to populate Redis from it
//   3. Writes 3 fallback bank memes to Redis
//   4. Verifies kill_switch is set to false (system live)

import "../shared/env.js"; // must be first — loads .env before anything reads process.env
import { insertStyleLogHistory } from "../harness/db.js";
import { kvSet, kvGet } from "../harness/store.js";
import { runDailyRefresh } from "../shared/dailyRefresh.js";
import { buildInitialStyleLog } from "../modules/styleSeed.js";
import { v4 as uuidv4 } from "uuid";
import type { FallbackMeme } from "../shared/types.js";
import { NICHE } from "../shared/constants.js";
import type { KillSwitchState } from "../harness/types.js";

// Pre-approved evergreen fallback memes — replace URLs with real, manually-reviewed
// meme images (e.g. generated via Memegen.link) before go-live.
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

  // Step 1: build the initial style log (scrape + extract) and write it to Postgres
  const styleLog = await buildInitialStyleLog();
  await insertStyleLogHistory(NICHE, uuidv4(), styleLog);
  console.info(`[seed] initial style log written to Postgres (${styleLog.topics.length} topics)`);

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
  console.info("  3. Deploy the app process");
}

main().catch((err) => {
  console.error("[seed] setup failed:", err);
  process.exit(1);
});

// Daily growth-engagement caps (Features 1 & 2).
//
// Two self-resetting daily counters in Redis, same pattern as generation_cap:today:
//   follows_today — at most FOLLOW_DAILY_CAP follows/day (20)
//   likes_today   — at most LIKE_DAILY_CAP likes/day (50)
//
// Each is a { date, count } object with a 24hr TTL. Unlike generation_cap, these
// are NOT pre-written by the daily refresh — they initialize lazily on first use
// and reset two ways: the TTL expires the key, and a date mismatch (process saw a
// day boundary before the key expired) is treated as a fresh count. The cap is
// checked before every action so we stop the moment we hit the limit, regardless
// of what's left in the cycle.

import { kvGet, kvSet } from "../harness/store.js";
import { FOLLOW_DAILY_CAP, LIKE_DAILY_CAP } from "./constants.js";

const FOLLOWS_KEY = "follows_today";
const LIKES_KEY = "likes_today";
const TTL_SECONDS = 24 * 60 * 60;

interface DailyCounter {
  date: string; // YYYY-MM-DD
  count: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Current count for the key, treating a missing key or a stale date as 0.
async function readCount(key: string): Promise<number> {
  const counter = await kvGet<DailyCounter>(key);
  if (!counter || counter.date !== today()) return 0;
  return counter.count;
}

// Bump the key's count by one, re-anchoring to today if the stored date is stale
// (or the key was missing). Always (re)sets the 24hr TTL.
async function bumpCount(key: string): Promise<number> {
  const current = await readCount(key);
  const next = current + 1;
  await kvSet<DailyCounter>(key, { date: today(), count: next }, TTL_SECONDS);
  return next;
}

export async function getFollowsToday(): Promise<number> {
  return readCount(FOLLOWS_KEY);
}

export async function canFollowMore(): Promise<boolean> {
  return (await readCount(FOLLOWS_KEY)) < FOLLOW_DAILY_CAP;
}

// Record one follow against today's count. Returns the new total.
export async function recordFollow(): Promise<number> {
  return bumpCount(FOLLOWS_KEY);
}

export async function getLikesToday(): Promise<number> {
  return readCount(LIKES_KEY);
}

export async function canLikeMore(): Promise<boolean> {
  return (await readCount(LIKES_KEY)) < LIKE_DAILY_CAP;
}

// Record one like against today's count. Returns the new total.
export async function recordLike(): Promise<number> {
  return bumpCount(LIKES_KEY);
}

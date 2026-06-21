# Build Log & Next-Build Suggestions

## Build 2 — 2026-06-21 (Memelord removed)

Memelord was never legitimate (dead endpoint, non-working key). Removed entirely and
replaced with: **Memegen.link** (free, keyless, default path) for all generation
incl. the 3 mandatory posts, and **Magic Hour** (`magic-hour` SDK) for exploratory
slots only, with reactive fallback to Memegen.link on a 402 depleted balance. The
old per-call Memelord "credit budget" became a simple **generation cap** (3 mandatory
+ 5 exploratory/day) in Redis `generation_cap:today`. `MEMELORD_API_KEY` removed;
`MAGICHOUR_API_KEY` added (optional).

## Build 1 — 2026-06-19

### What was built

Full implementation of the spec (phases 1-8), starting from the flat harness prototype files.

**Project structure created:**
```
src/
  harness/          — core safety wrapper (updated from prototype)
    index.ts        — harnessedCall with correlationId, fail-open kill switch, infra error guarding
    store.ts        — Redis with reconnect strategy + command queue cap
    circuitBreaker.ts — half-open state (auto-reset after 5min cooldown)
    killSwitch.ts   — unchanged logic, improved error docs
    retry.ts        — added shouldAbort callback for kill-switch-mid-retry
    logger.ts       — now writes to Postgres run_log (not Redis list)
    types.ts        — added correlationId, CircuitStatus, half-open fields
    db.ts           — Drizzle client + typed query helpers for all 4 tables
    __tests__/
      harness.test.ts — 21 unit tests (all passing)
  db/
    schema.ts       — Drizzle/Postgres schema: post_records, post_metrics, run_log, style_log_history
  shared/
    types.ts        — StyleLog, CreditBudget, FallbackMeme, GeneratedMeme, PostingSlot, RawEngagementMetrics
    constants.ts    — BLOCKED_TOPICS, POSTING_WINDOWS, SCORE_WEIGHTS, niche config
    dailyRefresh.ts — reads Postgres, writes Redis daily cache
  agents/
    meme-generator/index.ts — style log reader, topic selector, Memelord API call, fallback bank
    social-media/
      scheduler.ts  — randomized EST window posting schedule
      index.ts      — Bluesky posting, slot idempotency, engagement polling, reply pass
    analytics/index.ts — scoring (§4.1 formula), sentiment via Gemini Flash, style log updates
  orchestrator/
    openClaw.ts     — always-on loop, dispatch, daily refresh trigger, safety review chain
  scripts/
    seed.ts         — one-time setup: initial style log, fallback bank, kill switch init
  processes/
    orchestrator.ts — Railway process entrypoint
package.json        — full dependency list + per-process Railway start scripts
tsconfig.json       — NodeNext, ESM, strict mode
drizzle.config.ts
vitest.config.ts
.env.example
```

### Harness improvements (review items addressed)

1. **Unit tests** — 21 tests covering: kill switch on/off/Redis-down, circuit open/closed/half-open probe, Redis failure mid-operation (retries, exhaustion, Redis-down-during-log), Memelord timeout → circuit trip, kill switch flipped mid-retry, correlationId propagation on success/failure/skipped, scoring formula.

2. **Redis reconnection** — `createClient` now has a `socket.reconnectStrategy` with exponential backoff (200ms increments, 5s cap, stops after 10 retries). `commandsQueueMaxLength: 100` prevents unbounded memory growth during outages.

3. **Circuit breaker half-open state** — State machine: CLOSED → OPEN (3 failures) → HALF-OPEN (after 5min cooldown) → CLOSED (probe success) or OPEN (probe fail, cooldown resets). Auto-reset chosen over manual for unsupervised operation (see tradeoffs below).

4. **correlationId threading** — `harnessedCall` accepts optional `correlationId` string. Propagated to all `log()` calls and stored in `run_log.correlation_id`. Allows `SELECT * FROM run_log WHERE correlation_id = 'X'` to pull one full posting cycle end-to-end.

5. **Infra error guarding in catch block** — `recordFailure()` and `log()` in the catch path of `harnessedCall` now have `.catch()` handlers, so a Redis write failure during error handling can't mask the original fn error.

6. **Fail-open kill switch on Redis down** — if `isPaused()` throws (Redis unreachable), `harnessedCall` logs a warning and defaults to not-paused. Rationale: Redis reconnect logic handles transient outages; pausing all activity for a Redis blip is worse than continuing.

7. **Logger writes to Postgres** — `logger.ts` now calls `insertRunLogEntry()` (Drizzle, `run_log` table) instead of `kvAppend` to a Redis list. Console output is kept as fallback; Postgres write errors are caught and console-only logged without propagating.

### Auto-reset vs manual circuit breaker (§ you asked for explicitly)

**Auto-reset (half-open state) — chosen for this system:**
- Recovers without human intervention, essential for multi-day unsupervised runs
- Half-open state lets one probe through instead of flooding a recovering service
- Observable: permanent failures (wrong API key, dead endpoint) cycle open→half-open→open every 5min, generating visible `circuit-open` entries in run_log — this IS the alert mechanism

**Auto-reset risks:**
- Doesn't prevent the system from retrying a permanently broken dependency (it just does so slowly at cooldown intervals, not in a fast loop)
- Could close the circuit if a degraded service happens to handle one probe but fails on the next

**Manual reset:**
- Forces human confirmation the underlying issue is fixed
- Zero risk of re-flooding a recovering service
- Completely incompatible with unsupervised operation

**Decision:** Auto-reset with half-open state is the only viable choice for this system. The mitigation for permanent failures is queryable observability (run_log) and a future alerting hook in OpenClaw's clock loop (see gaps below).

---

## Known gaps for next build

See `GAPS.md` below (or check the persistent memory at `~/.claude/projects/.../memory/harness-gaps.md`).

Priority order:
1. Thread topic through to post record (data quality for scoring)
2. Fetch actual reply texts for sentiment (currently scoring against empty list)
3. Persistent `last_refresh_day` key in Redis (not in-process variable, breaks on restart)
4. Alerting when circuit-open count spikes (needed before unsupervised launch)
5. Mem0 qualitative memory — DONE. Wired into Analytics: `synthesizeStrategy` recalls prior cross-cutting learnings from Mem0 to inform the daily strategy pass and stores newly-derived ones (e.g. day-of-week effects), alongside the structured Postgres style log (§3.5). NOTE: the earlier "stub only" label was inaccurate — there was no stub; the `mem0ai` SDK was installed but entirely unused until this change.
6. Replace fallback bank placeholder image URLs with real, reviewed meme images (e.g. via Memegen.link)
7. Redis MULTI/EXEC for style log mid-day update (race condition on concurrent processes)
8. A/B variant generation (budget exists, not implemented)

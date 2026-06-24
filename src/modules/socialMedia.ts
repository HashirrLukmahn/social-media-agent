// Social Media module
// Owns: posting to Bluesky, engagement polling, idempotency guard, Postgres-backed job scheduling.
// Does not own the clock loop or daily refresh — those live in scheduler.ts.

import { BskyAgent, RichText } from "@atproto/api";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import { harnessedCall } from "../harness/index.js";
import {
  insertPostRecord,
  updatePostRecord,
  insertScheduledJob,
  getRecentPostRecords,
  insertFollow,
  getFollowedDids,
  getTakedownUris,
} from "../harness/db.js";
import { notifyMemePosted } from "../harness/alert.js";
import { rememberPostedMeme } from "../shared/mem0.js";
import { completeText } from "../shared/llm.js";
import {
  canFollowMore,
  recordFollow,
  canLikeMore,
  recordLike,
} from "../shared/engagementCap.js";
import {
  DEFAULT_HASHTAGS,
  MAX_REPLIES_PER_CYCLE,
  NICHE,
  NICHE_HASHTAGS,
  FOLLOW_DELAY_SECONDS,
  LIKE_DELAY_SECONDS,
  FOLLOW_MIN_NICHE_POSTS,
  LIKE_MIN_REPOSTS,
  LIKE_MIN_LIKES,
} from "../shared/constants.js";
import type { GeneratedMeme, RawEngagementMetrics } from "../shared/types.js";

let bskyAgent: BskyAgent | null = null;

// Exported so the daily Bluesky trending-themes job (Feature 3) reuses the same
// logged-in agent singleton rather than opening a second session.
export async function getBskyAgent(): Promise<BskyAgent> {
  if (bskyAgent) return bskyAgent;

  bskyAgent = new BskyAgent({ service: "https://bsky.social" });
  await bskyAgent.login({
    identifier: process.env["BSKY_HANDLE"] ?? (() => { throw new Error("BSKY_HANDLE not set"); })(),
    password: process.env["BSKY_APP_PASSWORD"] ?? (() => { throw new Error("BSKY_APP_PASSWORD not set"); })(),
  });
  return bskyAgent;
}

// Bluesky's PDS rejects image blobs larger than ~1MB. Memegen PNGs are well under
// this; a Magic Hour output could exceed it, in which case we fail the post with a
// legible error instead of a cryptic API rejection.
const MAX_BLOB_BYTES = 1_000_000;

// Best-effort content type from the URL extension when the server doesn't send a
// usable image content-type header.
function guessImageType(url: string): string {
  const u = url.toLowerCase();
  if (u.includes(".jpg") || u.includes(".jpeg")) return "image/jpeg";
  if (u.includes(".webp")) return "image/webp";
  if (u.includes(".gif")) return "image/gif";
  return "image/png";
}

// Downscale/recompress an over-limit image until it fits Bluesky's blob cap. Memes are
// fine as JPEG (the small text-quality loss is invisible at these sizes), and JPEG
// compresses the photographic Magic Hour outputs far better than PNG. Tries descending
// widths × qualities and returns the first result under the limit.
async function downscaleToLimit(
  input: Uint8Array,
  maxBytes: number
): Promise<{ bytes: Uint8Array; encoding: string }> {
  let smallest: Buffer | null = null;
  for (const width of [1600, 1200, 1000, 800, 600]) {
    for (const quality of [85, 75, 65, 55]) {
      const out = await sharp(input)
        .rotate() // honor EXIF orientation before resizing
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (out.byteLength <= maxBytes) return { bytes: new Uint8Array(out), encoding: "image/jpeg" };
      smallest = out;
    }
  }
  // Even the smallest attempt didn't fit — surface it rather than emit a cryptic API error.
  throw new Error(`could not downscale meme image under ${maxBytes} bytes (smallest=${smallest?.byteLength ?? "?"})`);
}

// Fetch the generated meme image (Memegen.link or Magic Hour returns only a URL) and
// upload the bytes to the PDS as a blob, so the meme renders INLINE on Bluesky rather
// than as an external link card. Downscales anything over Bluesky's blob cap. Returns
// the BlobRef to embed.
async function uploadMemeImage(agent: BskyAgent, imageUrl: string) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`fetch meme image failed: ${res.status} ${res.statusText}`);

  const headerType = res.headers.get("content-type")?.split(";")[0]?.trim();
  let encoding = headerType && headerType.startsWith("image/") ? headerType : guessImageType(imageUrl);

  let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("meme image was empty (0 bytes)");

  if (bytes.byteLength > MAX_BLOB_BYTES) {
    console.info(`[social-media] meme image ${bytes.byteLength}B exceeds ${MAX_BLOB_BYTES}B cap — downscaling`);
    const reduced = await downscaleToLimit(bytes, MAX_BLOB_BYTES);
    bytes = reduced.bytes;
    encoding = reduced.encoding;
    console.info(`[social-media] downscaled meme image to ${bytes.byteLength}B (${encoding})`);
  }

  const { data } = await agent.uploadBlob(bytes, { encoding });
  return data.blob;
}

async function postBluesky(
  meme: GeneratedMeme,
  correlationId?: string
): Promise<string> {
  return harnessedCall(
    {
      agentName: "social-media",
      action: "post-to-bluesky",
      input: { caption: meme.caption.slice(0, 80) },
      correlationId,
      attempts: 2,
    },
    async () => {
      const agent = await getBskyAgent();

      // Upload the image first so it embeds inline. A failed upload fails the post
      // (and is retried by the harness) — we never fall back to a bare link card.
      const blob = await uploadMemeImage(agent, meme.imageUrl);

      // Prefer the topic-tailored hashtags the generator produced; fall back to the
      // static defaults if the model returned none.
      const hashtags = meme.hashtags.length > 0 ? meme.hashtags : [...DEFAULT_HASHTAGS];
      const fullText = [meme.caption, hashtags.join(" ")].join("\n\n");
      const rt = new RichText({ text: fullText });
      await rt.detectFacets(agent);

      const post = await agent.post({
        text: rt.text,
        ...(rt.facets !== undefined ? { facets: rt.facets } : {}),
        embed: {
          $type: "app.bsky.embed.images",
          images: [{ image: blob, alt: meme.caption.slice(0, 1000) }],
        },
      });

      return post.uri;
    }
  );
}

export async function pollEngagement(
  blueskyUri: string,
  slotId: string,
  checkpoint: "1hr" | "6hr" | "24hr",
  correlationId?: string
): Promise<RawEngagementMetrics> {
  return harnessedCall(
    {
      agentName: "social-media",
      action: `poll-engagement-${checkpoint}`,
      input: { slotId, checkpoint },
      correlationId,
      attempts: 3,
      baseDelayMs: 2000,
    },
    async () => {
      const agent = await getBskyAgent();
      const { data: thread } = await agent.getPostThread({ uri: blueskyUri });
      const post = (thread.thread as { post?: { likeCount?: number; repostCount?: number; replyCount?: number } }).post;

      return {
        slotId,
        checkpoint,
        likes: post?.likeCount ?? 0,
        reposts: post?.repostCount ?? 0,
        replies: post?.replyCount ?? 0,
        views: 0, // Bluesky doesn't expose view count in thread endpoint
        followerDelta: 0, // computed against baseline stored at post time
        blueskyUri,
      };
    }
  );
}

// Inserts Postgres rows for the three polling checkpoints.
// The scheduler's clock loop picks these up and fires them via fireDueJobs().
export async function scheduleEngagementPolls(
  blueskyUri: string,
  slotId: string,
  correlationId: string
): Promise<void> {
  const checkpoints: Array<{ checkpoint: "1hr" | "6hr" | "24hr"; delayMs: number }> = [
    { checkpoint: "1hr", delayMs: 60 * 60_000 },
    { checkpoint: "6hr", delayMs: 6 * 60 * 60_000 },
    { checkpoint: "24hr", delayMs: 24 * 60 * 60_000 },
  ];

  for (const { checkpoint, delayMs } of checkpoints) {
    const fireAt = new Date(Date.now() + delayMs);
    await insertScheduledJob({
      id: `${slotId}:${checkpoint}`,
      slotId,
      checkpoint,
      correlationId,
      blueskyUri,
      fireAt,
      status: "pending",
    });
  }
}

export async function runReplyEngagement(correlationId?: string): Promise<void> {
  return harnessedCall(
    {
      agentName: "social-media",
      action: "reply-engagement-pass",
      input: { niche: NICHE },
      correlationId,
      skipCircuitBreaker: false,
    },
    async () => {
      const agent = await getBskyAgent();

      const { data } = await agent.app.bsky.feed.searchPosts({
        q: "#devhumor OR #softwareengineering",
        limit: 25,
        sort: "latest",
      });

      let replied = 0;
      for (const feedView of data.posts) {
        if (replied >= MAX_REPLIES_PER_CYCLE) break;

        const post = feedView;
        if (
          post.author.handle === process.env["BSKY_HANDLE"] ||
          (post.likeCount ?? 0) < 1
        ) {
          continue;
        }

        void post;
        break;
      }
    }
  );
}

// ── Growth engagement pass (Features 1 & 2) ──────────────────────────────────
// After each posting cycle: one shared niche-hashtag search whose results feed both
// the follow-candidate (Feature 1) and like-candidate (Feature 2) identification.
// Every follow/like is wrapped in harnessedCall, capped per day, and spaced out with
// a random delay so we never act in a rapid burst. A single failed action logs and
// moves on — it never crashes the cycle.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Random delay in ms within [minSec, maxSec]. Spaces out growth actions.
function randomDelayMs(minSec: number, maxSec: number): number {
  return Math.round((minSec + Math.random() * (maxSec - minSec)) * 1000);
}

// Defensively-typed view of the fields we read off a Bluesky search result.
interface SearchPost {
  uri: string;
  cid: string;
  text: string;
  authorDid: string;
  authorHandle: string;
  alreadyFollowing: boolean; // from the post author's viewer state
  alreadyLiked: boolean; // from the post's viewer state
  likeCount: number;
  repostCount: number;
  matchedHashtag: string; // first niche hashtag found in the post text ("" if none)
}

// First niche hashtag present in the text (case-insensitive), or "" — used to record
// which hashtag surfaced a follow.
function matchHashtag(text: string): string {
  const lower = text.toLowerCase();
  for (const tag of NICHE_HASHTAGS) {
    if (lower.includes(tag.toLowerCase())) return tag;
  }
  return "";
}

// Normalize a raw Bluesky PostView into the subset of fields we use. Tolerant of
// missing/loosely-typed fields so a malformed result can never throw mid-pass.
function normalizeSearchPost(raw: unknown): SearchPost | null {
  const p = raw as {
    uri?: string;
    cid?: string;
    record?: { text?: string };
    author?: { did?: string; handle?: string; viewer?: { following?: string } };
    viewer?: { like?: string };
    likeCount?: number;
    repostCount?: number;
  };
  if (!p.uri || !p.cid || !p.author?.did || !p.author?.handle) return null;
  const text = typeof p.record?.text === "string" ? p.record.text : "";
  return {
    uri: p.uri,
    cid: p.cid,
    text,
    authorDid: p.author.did,
    authorHandle: p.author.handle,
    alreadyFollowing: Boolean(p.author.viewer?.following),
    alreadyLiked: Boolean(p.viewer?.like),
    likeCount: typeof p.likeCount === "number" ? p.likeCount : 0,
    repostCount: typeof p.repostCount === "number" ? p.repostCount : 0,
    matchedHashtag: matchHashtag(text),
  };
}

// Gemini-Flash-style YES/NO classifier (run on Claude Haiku via completeText, the
// project's standard cheap classifier path) — "is this a meme/humorous post?".
// Read-only: skips the circuit breaker and returns false on any failure (we simply
// don't like rather than mis-like).
async function isMemeOrHumor(caption: string, correlationId?: string): Promise<boolean> {
  if (!caption.trim()) return false;
  try {
    const text = await harnessedCall(
      {
        agentName: "social-media",
        action: "like-meme-classifier",
        input: { caption: caption.slice(0, 100) },
        correlationId,
        skipCircuitBreaker: true,
      },
      () =>
        completeText({
          system: "Is this a meme or humorous post? Reply YES or NO only.",
          user: caption,
          maxTokens: 4,
        })
    );
    return /^\s*yes/i.test(text);
  } catch (err) {
    console.warn("[social-media] meme classifier failed — not liking:", err instanceof Error ? err.message : err);
    return false;
  }
}

// Feature 1 — follow up to FOLLOW_DAILY_CAP accounts/day that have posted at least
// FOLLOW_MIN_NICHE_POSTS times in the niche hashtags, aren't us, and we don't
// already follow. Spaced 30–90s apart.
async function runFollowPass(
  posts: SearchPost[],
  botDid: string,
  botHandle: string | undefined,
  correlationId?: string
): Promise<void> {
  // Tally posts per author from the shared search to find repeat niche posters.
  const byAuthor = new Map<
    string,
    { handle: string; count: number; source: string; alreadyFollowing: boolean }
  >();
  for (const post of posts) {
    const existing = byAuthor.get(post.authorDid);
    if (existing) {
      existing.count += 1;
      if (!existing.source && post.matchedHashtag) existing.source = post.matchedHashtag;
    } else {
      byAuthor.set(post.authorDid, {
        handle: post.authorHandle,
        count: 1,
        source: post.matchedHashtag,
        alreadyFollowing: post.alreadyFollowing,
      });
    }
  }

  const alreadyFollowedDids = await getFollowedDids().catch((err) => {
    console.warn("[social-media] could not load followed DIDs — skipping follow pass:", err instanceof Error ? err.message : err);
    return null;
  });
  if (alreadyFollowedDids === null) return;

  const candidates = [...byAuthor.entries()].filter(([did, info]) => {
    if (info.count < FOLLOW_MIN_NICHE_POSTS) return false; // not a repeat niche poster
    if (did === botDid || info.handle === botHandle) return false; // not ourselves
    if (info.alreadyFollowing) return false; // already following (viewer state)
    if (alreadyFollowedDids.has(did)) return false; // already followed (our record)
    return true;
  });

  console.info(`[social-media] follow pass: ${candidates.length} candidate accounts from ${posts.length} posts`);

  let first = true;
  for (const [did, info] of candidates) {
    // Re-check the daily cap before EVERY follow — stop the moment we hit 20,
    // regardless of how many candidates remain in the cycle.
    if (!(await canFollowMore())) {
      console.info("[social-media] daily follow cap reached — stopping follow pass");
      break;
    }

    // Space follows out 30–90s — never a rapid burst.
    if (!first) await sleep(randomDelayMs(FOLLOW_DELAY_SECONDS.min, FOLLOW_DELAY_SECONDS.max));
    first = false;

    try {
      await harnessedCall(
        {
          agentName: "social-media",
          action: "follow-account",
          input: { did, handle: info.handle, source: info.source },
          correlationId,
        },
        async () => {
          const agent = await getBskyAgent();
          await agent.follow(did);
        }
      );
      await insertFollow({
        id: uuidv4(),
        did,
        handle: info.handle,
        followedAt: new Date(),
        source: info.source || NICHE_HASHTAGS.join(","),
      });
      const total = await recordFollow();
      console.info(`[social-media] followed @${info.handle} (source: ${info.source || "niche"}) — ${total} today`);
    } catch (err) {
      // A failed follow logs and moves on — never crashes the cycle.
      console.warn(`[social-media] follow failed for @${info.handle}:`, err instanceof Error ? err.message : err);
    }
  }
}

// Feature 2 — like up to LIKE_DAILY_CAP posts/day that show real traction (>=1 repost
// OR >=3 likes), aren't ours, we haven't already liked, aren't in the takedown log,
// and the classifier judges a meme/humor post. Spaced 10–30s apart.
async function runLikePass(
  posts: SearchPost[],
  botHandle: string | undefined,
  correlationId?: string
): Promise<void> {
  const takenDownUris = await getTakedownUris().catch((err) => {
    console.warn("[social-media] could not load takedown log — skipping like pass:", err instanceof Error ? err.message : err);
    return null;
  });
  if (takenDownUris === null) return;

  let first = true;
  let likedCount = 0;
  for (const post of posts) {
    if (!(await canLikeMore())) {
      console.info("[social-media] daily like cap reached — stopping like pass");
      break;
    }

    // Cheap structural filters first (no network / no LLM):
    if (post.authorHandle === botHandle) continue; // not our own post
    if (post.alreadyLiked) continue; // already liked (viewer state)
    if (takenDownUris.has(post.uri)) continue; // flagged by safety review — never like
    const hasTraction = post.repostCount >= LIKE_MIN_REPOSTS || post.likeCount >= LIKE_MIN_LIKES;
    if (!hasTraction) continue; // not genuinely good, just in the feed

    // Only then spend an LLM call on the meme/humor classifier.
    if (!(await isMemeOrHumor(post.text, correlationId))) continue;

    // Space likes out 10–30s — never a rapid burst.
    if (!first) await sleep(randomDelayMs(LIKE_DELAY_SECONDS.min, LIKE_DELAY_SECONDS.max));
    first = false;

    try {
      await harnessedCall(
        {
          agentName: "social-media",
          action: "like-post",
          input: { uri: post.uri, handle: post.authorHandle },
          correlationId,
        },
        async () => {
          const agent = await getBskyAgent();
          await agent.like(post.uri, post.cid);
        }
      );
      const total = await recordLike();
      likedCount += 1;
      console.info(`[social-media] liked post by @${post.authorHandle} — ${total} today`);
    } catch (err) {
      // A failed like logs and moves on.
      console.warn(`[social-media] like failed for ${post.uri}:`, err instanceof Error ? err.message : err);
    }
  }
  console.info(`[social-media] like pass complete — ${likedCount} new likes this cycle`);
}

// Entry point for the per-cycle growth pass. Bluesky's searchPosts does NOT support
// boolean OR — an OR-joined query (e.g. "#a OR #b") matches zero posts. So we search
// each niche hashtag separately and merge the results, de-duping by post URI so a
// post that surfaces under multiple tags is counted once. The merged set feeds both
// the follow and like passes.
export async function runEngagementGrowthPass(correlationId?: string): Promise<void> {
  const botHandle = process.env["BSKY_HANDLE"];

  const byUri = new Map<string, SearchPost>();
  for (const hashtag of NICHE_HASHTAGS) {
    try {
      const found = await harnessedCall(
        {
          agentName: "social-media",
          action: "growth-hashtag-search",
          input: { hashtag },
          correlationId,
          skipCircuitBreaker: true,
        },
        async () => {
          const agent = await getBskyAgent();
          const { data } = await agent.app.bsky.feed.searchPosts({
            q: hashtag,
            limit: 100,
            sort: "latest",
          });
          return data.posts
            .map(normalizeSearchPost)
            .filter((p): p is SearchPost => p !== null);
        }
      );
      for (const post of found) {
        if (!byUri.has(post.uri)) byUri.set(post.uri, post);
      }
    } catch (err) {
      // One hashtag's search failing must never abort the whole growth pass.
      console.warn(`[social-media] growth search failed for ${hashtag} — continuing:`, err instanceof Error ? err.message : err);
    }
  }

  const posts = [...byUri.values()];
  console.info(`[social-media] growth pass: ${posts.length} unique posts across ${NICHE_HASHTAGS.length} hashtags`);
  if (posts.length === 0) return; // nothing surfaced — both passes would no-op

  const agent = await getBskyAgent().catch(() => null);
  const botDid = agent?.session?.did ?? "";

  // Follow pass then like pass — both read from the same merged `posts`, no re-search.
  await runFollowPass(posts, botDid, botHandle, correlationId).catch((err) => {
    console.warn("[social-media] follow pass errored:", err instanceof Error ? err.message : err);
  });
  await runLikePass(posts, botHandle, correlationId).catch((err) => {
    console.warn("[social-media] like pass errored:", err instanceof Error ? err.message : err);
  });
}

// Posts a meme for the given slot. Handles idempotency, DB record lifecycle, and
// schedules Postgres-backed engagement polls on success.
export async function postMemeToSlot(
  slotId: string,
  meme: GeneratedMeme,
  correlationId: string
): Promise<void> {
  const existing = await getRecentPostRecords(NICHE, 1);
  const alreadyPosted = existing.some((r) => r.slotId === slotId && r.status === "posted");
  if (alreadyPosted) {
    console.info(`[social-media] slot ${slotId} already posted — skipping`);
    return;
  }

  await insertPostRecord({
    slotId,
    niche: NICHE,
    topic: meme.topic,
    templateUsed: meme.templateUsed,
    generator: meme.generator,
    imageUrl: meme.imageUrl,
    caption: meme.caption,
    status: "generated",
  });

  const blueskyUri = await postBluesky(meme, correlationId);

  await updatePostRecord(slotId, {
    blueskyUri,
    postedAt: new Date(),
    status: "posted",
  });

  console.info(`[social-media] posted slot ${slotId} → ${blueskyUri}`);

  // Surface the agent's reasoning + the info/themes/hashtags it used to Slack.
  // Best-effort: notifyMemePosted never throws, but guard anyway so a Slack hiccup
  // can't undo a successful post.
  await notifyMemePosted(meme, blueskyUri).catch((err) => {
    console.warn("[social-media] post notification failed:", err instanceof Error ? err.message : err);
  });

  // Persist this post to Mem0 so the next generation remembers which template was
  // used and avoids repeating it. Best-effort: a Mem0 outage must not fail the post.
  await rememberPostedMeme(meme.templateUsed, meme.topic).catch((err) => {
    console.warn("[social-media] mem0 remember-post failed:", err instanceof Error ? err.message : err);
  });

  await scheduleEngagementPolls(blueskyUri, slotId, correlationId);

  await runReplyEngagement(correlationId).catch((err) => {
    console.warn("[social-media] reply engagement pass failed:", err instanceof Error ? err.message : err);
  });

  // Features 1 & 2: follow relevant accounts + like relevant posts from one shared
  // niche-hashtag search. Best-effort — a growth-pass failure must never undo the
  // successful post or crash the cycle.
  await runEngagementGrowthPass(correlationId).catch((err) => {
    console.warn("[social-media] engagement growth pass failed:", err instanceof Error ? err.message : err);
  });
}

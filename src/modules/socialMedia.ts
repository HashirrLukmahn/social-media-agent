// Social Media module
// Owns: posting to Bluesky, engagement polling, idempotency guard, Postgres-backed job scheduling.
// Does not own the clock loop or daily refresh — those live in scheduler.ts.

import { BskyAgent, RichText } from "@atproto/api";
import { harnessedCall } from "../harness/index.js";
import {
  insertPostRecord,
  updatePostRecord,
  insertScheduledJob,
  getRecentPostRecords,
} from "../harness/db.js";
import { DEFAULT_HASHTAGS, MAX_REPLIES_PER_CYCLE, NICHE } from "../shared/constants.js";
import type { GeneratedMeme, RawEngagementMetrics } from "../shared/types.js";

let bskyAgent: BskyAgent | null = null;

async function getBskyAgent(): Promise<BskyAgent> {
  if (bskyAgent) return bskyAgent;

  bskyAgent = new BskyAgent({ service: "https://bsky.social" });
  await bskyAgent.login({
    identifier: process.env["BSKY_HANDLE"] ?? (() => { throw new Error("BSKY_HANDLE not set"); })(),
    password: process.env["BSKY_APP_PASSWORD"] ?? (() => { throw new Error("BSKY_APP_PASSWORD not set"); })(),
  });
  return bskyAgent;
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

      const fullText = [meme.caption, DEFAULT_HASHTAGS.join(" ")].join("\n\n");
      const rt = new RichText({ text: fullText });
      await rt.detectFacets(agent);

      const post = await agent.post({
        text: rt.text,
        ...(rt.facets !== undefined ? { facets: rt.facets } : {}),
        embed: {
          $type: "app.bsky.embed.external",
          external: {
            uri: meme.imageUrl,
            title: "Meme",
            description: meme.caption,
          },
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

  await scheduleEngagementPolls(blueskyUri, slotId, correlationId);

  await runReplyEngagement(correlationId).catch((err) => {
    console.warn("[social-media] reply engagement pass failed:", err instanceof Error ? err.message : err);
  });
}

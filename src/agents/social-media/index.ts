// Social Media Agent
// Owns: scheduling, posting to Bluesky, engagement polling.
// Knows nothing about meme generation or scoring — hands raw metrics to analytics.

import { BskyAgent, RichText } from "@atproto/api";
import { harnessedCall } from "../../harness/index.js";
import { insertPostRecord, updatePostRecord, insertPostMetrics } from "../../harness/db.js";
import { buildTodaySchedule, msUntil, msUntilPrePing } from "./scheduler.js";
import { DEFAULT_HASHTAGS, MAX_REPLIES_PER_CYCLE, NICHE } from "../../shared/constants.js";
import type { GeneratedMeme, PostingSlot, RawEngagementMetrics } from "../../shared/types.js";

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

async function postMeme(
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

      const fullText = [
        meme.caption,
        DEFAULT_HASHTAGS.join(" "),
      ].join("\n\n");

      const rt = new RichText({ text: fullText });
      await rt.detectFacets(agent);

      const post = await agent.post({
        text: rt.text,
        facets: rt.facets,
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

async function pollEngagement(
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

      const profileBefore = await agent.getProfile({ actor: process.env["BSKY_HANDLE"]! });
      const followersBefore = profileBefore.data.followersCount ?? 0;

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

async function scheduleEngagementPolls(
  blueskyUri: string,
  slotId: string,
  correlationId: string,
  onMetrics: (metrics: RawEngagementMetrics) => Promise<void>
): Promise<void> {
  const checkpoints: Array<{ checkpoint: "1hr" | "6hr" | "24hr"; delayMs: number }> = [
    { checkpoint: "1hr", delayMs: 60 * 60_000 },
    { checkpoint: "6hr", delayMs: 6 * 60 * 60_000 },
    { checkpoint: "24hr", delayMs: 24 * 60 * 60_000 },
  ];

  for (const { checkpoint, delayMs } of checkpoints) {
    setTimeout(async () => {
      try {
        const metrics = await pollEngagement(blueskyUri, slotId, checkpoint, correlationId);
        await insertPostMetrics({
          id: `${slotId}:${checkpoint}`,
          postId: slotId,
          checkpoint,
          likes: metrics.likes,
          reposts: metrics.reposts,
          replies: metrics.replies,
          views: metrics.views,
          followerDelta: metrics.followerDelta,
          sentimentAdjustedReplies: null,
        });
        await onMetrics(metrics);
      } catch (err) {
        console.error(
          `[social-media] engagement poll ${checkpoint} failed for ${slotId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }, delayMs);
  }
}

async function runReplyEngagement(correlationId?: string): Promise<void> {
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

      const { data } = await agent.searchPosts({
        q: "#devhumor OR #softwareengineering",
        limit: 25,
        sort: "latest",
      });

      let replied = 0;
      for (const feedView of data.posts) {
        if (replied >= MAX_REPLIES_PER_CYCLE) break;

        // Only reply to posts from non-bots that have some engagement (not spam)
        const post = feedView;
        if (
          post.author.handle === process.env["BSKY_HANDLE"] ||
          (post.likeCount ?? 0) < 1
        ) {
          continue;
        }

        // Genuine reply generated by analytics/content logic would go here.
        // Placeholder: skip for now, implement in Analytics Agent integration.
        void post;
        break;
      }
    }
  );
}

export async function handleSlot(
  slot: PostingSlot,
  meme: GeneratedMeme,
  onMetrics: (metrics: RawEngagementMetrics) => Promise<void>
): Promise<void> {
  const { slotId, correlationId } = slot;

  // Idempotency: if we've already posted for this slot, skip.
  // Checked via Postgres — survives restarts.
  const { getRecentPostRecords } = await import("../../harness/db.js");
  const existing = await getRecentPostRecords(NICHE, 1);
  const alreadyPosted = existing.some((r) => r.slotId === slotId && r.status === "posted");
  if (alreadyPosted) {
    console.info(`[social-media] slot ${slotId} already posted — skipping`);
    return;
  }

  // Record "generated" state in Postgres before posting.
  await insertPostRecord({
    slotId,
    niche: NICHE,
    topic: "unknown", // populated by orchestrator when it has the topic context
    imageUrl: meme.imageUrl,
    caption: meme.caption,
    status: "generated",
  });

  const blueskyUri = await postMeme(meme, correlationId);

  await updatePostRecord(slotId, {
    blueskyUri,
    postedAt: new Date(),
    status: "posted",
  });

  console.info(`[social-media] posted slot ${slotId} → ${blueskyUri}`);

  await scheduleEngagementPolls(blueskyUri, slotId, correlationId, onMetrics);
  await runReplyEngagement(correlationId).catch((err) => {
    // Reply engagement is best-effort — a failure here must not affect the post.
    console.warn("[social-media] reply engagement pass failed:", err instanceof Error ? err.message : err);
  });
}

// Entry point for the always-on Social Media Agent process.
// Signals back to OpenClaw via callbacks — no direct inter-agent calls.
export async function startSocialMediaAgent(callbacks: {
  onPrePing: (slot: PostingSlot) => Promise<GeneratedMeme>;
  onMetrics: (metrics: RawEngagementMetrics) => Promise<void>;
}): Promise<void> {
  console.info("[social-media] agent started");

  async function runDay(): Promise<void> {
    const schedule = buildTodaySchedule();
    console.info(
      `[social-media] today's schedule: ${schedule.map((s) => `${s.slotId}@${s.scheduledAt.toISOString()}`).join(", ")}`
    );

    for (const slot of schedule) {
      const prePingWait = msUntilPrePing(slot);
      if (prePingWait > 0) {
        await new Promise((resolve) => setTimeout(resolve, prePingWait));
      }

      let meme: GeneratedMeme;
      try {
        meme = await callbacks.onPrePing(slot);
      } catch (err) {
        console.error(`[social-media] pre-ping failed for slot ${slot.slotId}:`, err instanceof Error ? err.message : err);
        continue;
      }

      const postWait = msUntil(slot.scheduledAt);
      if (postWait > 0) {
        await new Promise((resolve) => setTimeout(resolve, postWait));
      }

      try {
        await handleSlot(slot, meme, callbacks.onMetrics);
      } catch (err) {
        console.error(`[social-media] slot ${slot.slotId} failed:`, err instanceof Error ? err.message : err);
      }
    }

    // Wait until next day (midnight UTC) then repeat.
    const now = new Date();
    const tomorrowUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    );
    const waitMs = tomorrowUtc.getTime() - Date.now();
    console.info(`[social-media] day complete, sleeping ${Math.round(waitMs / 60_000)} min until tomorrow`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  while (true) {
    await runDay().catch((err) => {
      console.error("[social-media] runDay crashed:", err instanceof Error ? err.message : err);
    });
  }
}

// Meme Generator (§2.1). Produces one meme from style context.
//
// Memelord (dead/illegitimate) was removed. Generation now has two paths:
//   - DEFAULT: Memegen.link — free, keyless template memes. Used for everything,
//     always for the 3 mandatory scheduled posts.
//   - EXPLORATORY ONLY: Magic Hour — real generative AI, pay-per-call, capped to
//     exploratory slots and never reachable from a mandatory post. Falls back to
//     Memegen.link if its balance is depleted (§3.7-style graceful degradation).
//
// Because Memegen.link only renders text onto a template (no creative step), an LLM
// pass first turns the topic + style context into a meme spec: which template, the
// on-image text, and a Bluesky caption.

import { harnessedCall } from "../harness/index.js";
import { kvGet } from "../harness/store.js";
import { completeText } from "../shared/llm.js";
import { getTemplates, renderMemegen } from "./memegen.js";
import { renderMagicHour, isDepletedError } from "./magicHour.js";
import { assertGenerationAllowed, recordGeneration, type GenerationType } from "../shared/generationCap.js";
import type { FallbackMeme, GeneratedMeme, StyleLog } from "../shared/types.js";
import { BLOCKED_TOPICS, SAFETY_CONSTRAINTS } from "../shared/constants.js";

const STYLE_LOG_KEY = "style_log:today";
const FALLBACK_BANK_KEY = "fallback_bank";

// Curated Memegen.link templates + when to use each. Only those present in the live
// catalog are offered to the model (the rest are silently dropped), so the model
// can only pick a valid id. drake/fine/aag are the guaranteed-present anchors.
const TEMPLATE_HINTS: Record<string, string> = {
  drake: "comparison / preference: reject the top option, prefer the bottom",
  fine: "'this is fine': calm denial while everything is on fire / chaos",
  aag: "'always has been': realizing something was true all along (top 'wait, it's all X?', bottom 'always has been')",
  gru: "a plan whose final step backfires on the planner",
  db: "distracted boyfriend: tempted by a shiny new thing over the current one",
  spongebob: "mocking SpongeBob: sarcastic mocking repetition of someone's words",
  success: "success kid: a small, unexpected win",
  disastergirl: "smug in front of a disaster you quietly caused",
  rollsafe: "tapping head: dubious 'can't have a problem if...' galaxy-brain logic",
  fry: "Futurama Fry: 'not sure if X or just Y'",
  ds: "two buttons: sweating over two conflicting options",
};
const ANCHOR_TEMPLATES = ["drake", "fine", "aag"];

interface MemeSpec {
  template: string;
  topText: string;
  bottomText: string;
  caption: string;
}

function styleContext(styleLog: StyleLog): string {
  const parts: string[] = [];
  if (styleLog.audienceNotes) {
    parts.push(`Audience insight (from real engagement data):\n${styleLog.audienceNotes}`);
  }
  if (styleLog.formatNotes.length > 0) {
    parts.push(`Format guidance from past performance:\n${styleLog.formatNotes.map((n) => `- ${n}`).join("\n")}`);
  }
  // §3.7: trending themes + current events are OPTIONAL topic inspiration only.
  if (styleLog.trendingThemes.length > 0) {
    parts.push(`Trending themes (optional — use only if one fits naturally, never copy a specific joke):\n${styleLog.trendingThemes.map((t) => `- ${t}`).join("\n")}`);
  }
  if (styleLog.currentEventsContext.length > 0) {
    parts.push(`Current events (optional — only if it fits the niche and style):\n${styleLog.currentEventsContext.map((e) => `- ${e}`).join("\n")}`);
  }
  // §3.7: public sentiment is a TONE modifier, not a topic. Only hostile changes anything.
  if (styleLog.publicSentimentTowardDevs?.tone === "hostile") {
    parts.push(`Tone calibration: public sentiment toward developers is currently hostile (${styleLog.publicSentimentTowardDevs.reason}). Lean self-deprecating / in-on-the-joke, not triumphant. Framing only — keep the chosen topic.`);
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

function selectTopic(styleLog: StyleLog): string {
  const safeCandidates = styleLog.topics.filter(
    (t) => !BLOCKED_TOPICS.some((b) => t.name.toLowerCase().includes(b))
  );

  if (safeCandidates.length === 0) {
    return "debugging mysteries";
  }

  const weights = safeCandidates.map((t) => {
    if (t.confidence === "established") return t.avgScore + 0.5;
    if (t.confidence === "emerging") return t.avgScore + 0.2;
    return 0.1;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let pick = Math.random() * total;
  for (let i = 0; i < safeCandidates.length; i++) {
    pick -= weights[i] ?? 0;
    if (pick <= 0) return safeCandidates[i]?.name ?? "debugging mysteries";
  }
  return safeCandidates[safeCandidates.length - 1]?.name ?? "debugging mysteries";
}

// LLM pass: topic + style context → { template, topText, bottomText, caption }.
async function generateMemeSpec(
  styleLog: StyleLog,
  topic: string,
  validTemplateIds: Set<string>,
  correlationId?: string
): Promise<MemeSpec> {
  const offered = Object.entries(TEMPLATE_HINTS).filter(([id]) => validTemplateIds.has(id));
  const menu = offered.map(([id, hint]) => `- ${id}: ${hint}`).join("\n");
  const defaultTemplate =
    offered.find(([id]) => ANCHOR_TEMPLATES.includes(id))?.[0] ?? offered[0]?.[0] ?? "drake";

  const system = `You write a single software-engineering humor meme for a Bluesky audience. Pick ONE meme template from the menu whose structure best fits the joke, write the on-image text, and a separate short Bluesky caption.

${SAFETY_CONSTRAINTS}

Rules:
- topText / bottomText are the words ON the image. Keep each short and punchy. If the template only needs one line, put it in topText and leave bottomText empty.
- caption is the Bluesky post text that accompanies the image — one relatable line, no hashtags (those are added later).
- Style: dry, absurdist, or relatable-pain humor. Let the image carry the setup.

Respond with ONLY valid JSON, no markdown:
{ "template": "<one id from the menu>", "topText": "...", "bottomText": "...", "caption": "..." }`;

  const user = `Topic: ${topic}
Niche: ${styleLog.niche}${styleContext(styleLog)}

Template menu (choose the id whose structure fits the joke best):
${menu}`;

  const text = await completeText({ system, user, maxTokens: 512 });
  const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

  let parsed: { template?: unknown; topText?: unknown; bottomText?: unknown; caption?: unknown };
  try {
    parsed = JSON.parse(clean) as typeof parsed;
  } catch {
    console.warn("[meme-generator] could not parse meme spec — using a minimal default");
    parsed = {};
  }

  const template = typeof parsed.template === "string" && validTemplateIds.has(parsed.template)
    ? parsed.template
    : defaultTemplate;
  const topText = typeof parsed.topText === "string" ? parsed.topText : topic;
  const bottomText = typeof parsed.bottomText === "string" ? parsed.bottomText : "";
  const caption = typeof parsed.caption === "string" && parsed.caption.length > 0 ? parsed.caption : topic;

  return { template, topText, bottomText, caption };
}

export async function getFallbackMeme(): Promise<GeneratedMeme | null> {
  const bank = await kvGet<FallbackMeme[]>(FALLBACK_BANK_KEY);
  if (!bank || bank.length === 0) return null;

  const meme = bank[Math.floor(Math.random() * bank.length)];
  if (!meme) return null;

  return {
    imageUrl: meme.imageUrl,
    caption: meme.caption,
    templateUsed: "fallback",
    generator: "fallback",
    topic: "fallback",
  };
}

export interface GenerateOptions {
  // "mandatory" = one of the 3 scheduled posts (Memegen.link only). "exploratory"
  // = a creative/test generation, eligible for Magic Hour. Defaults to mandatory.
  type?: GenerationType;
  // Only honored for exploratory generations: route to Magic Hour (novel format /
  // doesn't fit a Memegen template). Ignored for mandatory — those never hit Magic Hour.
  preferMagicHour?: boolean;
}

export async function generateMeme(
  slotId: string,
  correlationId?: string,
  options?: GenerateOptions
): Promise<GeneratedMeme> {
  const type: GenerationType = options?.type ?? "mandatory";

  const styleLog = await kvGet<StyleLog>(STYLE_LOG_KEY);
  if (!styleLog) {
    throw new Error("Style log not found in Redis — run daily refresh first");
  }

  const topic = selectTopic(styleLog);
  if (BLOCKED_TOPICS.some((b) => topic.toLowerCase().includes(b))) {
    throw new Error(`Topic "${topic}" is on the blocklist`);
  }

  // §4: pacing cap. Mandatory always allowed; exploratory throws if the day's cap
  // is reached (caller decides whether to skip).
  await assertGenerationAllowed(type);

  try {
    const templates = await getTemplates();
    const spec = await harnessedCall(
      {
        agentName: "meme-generator",
        action: "meme-spec",
        input: { slotId, topic, type },
        correlationId,
        attempts: 3,
        baseDelayMs: 1000,
      },
      () => generateMemeSpec(styleLog, topic, new Set(templates.keys()), correlationId)
    );

    // Magic Hour is reachable ONLY for exploratory slots that opt in. Mandatory
    // posts can never reach it, regardless of preferMagicHour.
    const useMagicHour = type === "exploratory" && options?.preferMagicHour === true;

    let imageUrl: string;
    let generator: GeneratedMeme["generator"];

    if (useMagicHour) {
      try {
        imageUrl = await harnessedCall(
          { agentName: "meme-generator", action: "magic-hour-generate", input: { slotId, topic }, correlationId },
          () => renderMagicHour(topic)
        );
        generator = "magichour";
      } catch (mhErr) {
        if (isDepletedError(mhErr)) {
          console.info("[meme-generator] Magic Hour balance depleted — falling back to Memegen.link for this exploratory slot");
        } else {
          console.warn("[meme-generator] Magic Hour failed, falling back to Memegen.link:", mhErr instanceof Error ? mhErr.message : mhErr);
        }
        imageUrl = await harnessedCall(
          { agentName: "meme-generator", action: "memegen-render", input: { slotId, template: spec.template }, correlationId },
          () => renderMemegen(spec.template, [spec.topText, spec.bottomText])
        );
        generator = "memegen";
      }
    } else {
      imageUrl = await harnessedCall(
        { agentName: "meme-generator", action: "memegen-render", input: { slotId, template: spec.template }, correlationId },
        () => renderMemegen(spec.template, [spec.topText, spec.bottomText])
      );
      generator = "memegen";
    }

    await recordGeneration();

    return { imageUrl, caption: spec.caption, templateUsed: spec.template, generator, topic };
  } catch (err) {
    console.warn("[meme-generator] generation failed, attempting fallback bank:", err instanceof Error ? err.message : err);
    const fallback = await getFallbackMeme();
    if (fallback) {
      console.info("[meme-generator] using fallback meme");
      return fallback;
    }
    throw new Error("Generation failed and fallback bank is empty — slot must be skipped");
  }
}

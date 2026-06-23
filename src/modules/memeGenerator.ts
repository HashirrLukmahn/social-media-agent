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
import { getRecentTemplates } from "../harness/db.js";
import { recallRecentTemplates, rememberPostedMeme } from "../shared/mem0.js";
import { completeText, GENERATION_MODEL } from "../shared/llm.js";
import { getTemplates, renderMemegen } from "./memegen.js";
import { renderMagicHour, isDepletedError } from "./magicHour.js";
import { assertGenerationAllowed, recordGeneration, type GenerationType } from "../shared/generationCap.js";
import type { FallbackMeme, GeneratedMeme, Generator, StyleLog } from "../shared/types.js";
import { BLOCKED_TOPICS, DEFAULT_HASHTAGS, NICHE, SAFETY_CONSTRAINTS } from "../shared/constants.js";

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

// How many recently-used templates to block, and the floor below which we stop
// blocking so the menu can never collapse to nothing.
const RECENT_TEMPLATE_WINDOW = 4;
const MIN_TEMPLATE_CHOICES = 4;

interface MemeSpec {
  template: string;
  topText: string;
  bottomText: string;
  caption: string;
  // Short rationale for the template/joke choice + which inputs informed it.
  reasoning: string;
  // The specific style inputs the model says it drew on (themes/events/notes).
  themesReferenced: string[];
  // Topic-tailored hashtags (already normalized to start with #).
  hashtags: string[];
}

// Normalizes model-supplied hashtags: coerce to strings, strip whitespace, ensure a
// single leading #, drop empties/dupes, cap the count. Falls back to the defaults
// when nothing usable comes back so a post is never tagless.
function normalizeHashtags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_HASHTAGS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = "#" + item.trim().replace(/^#+/, "").replace(/\s+/g, "");
    if (tag.length <= 1) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 5) break;
  }
  return out.length > 0 ? out : [...DEFAULT_HASHTAGS];
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
  // Feature 3: what's landing on Bluesky's own feed today. OPTIONAL inspiration, same
  // as the other context fields — reference it only when something fits naturally.
  if (styleLog.blueskyTrendingThemes && styleLog.blueskyTrendingThemes.length > 0) {
    parts.push(`What's resonating on Bluesky today (optional — only if one fits naturally, never copy a specific joke):\n${styleLog.blueskyTrendingThemes.map((t) => `- ${t}`).join("\n")}`);
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
// recentTemplates are removed from the menu entirely (a hard guard, not a soft hint)
// so the model literally cannot pick a format it just used.
async function generateMemeSpec(
  styleLog: StyleLog,
  topic: string,
  validTemplateIds: Set<string>,
  recentTemplates: string[],
  correlationId?: string
): Promise<MemeSpec> {
  const available = Object.entries(TEMPLATE_HINTS).filter(([id]) => validTemplateIds.has(id));
  const recentSet = new Set(recentTemplates);

  // Drop recently-used templates — but if that leaves too few, relax the guard so we
  // always have a usable menu (e.g. catalog shrank or every template was just used).
  const trimmed = available.filter(([id]) => !recentSet.has(id));
  const offered = trimmed.length >= MIN_TEMPLATE_CHOICES ? trimmed : available;

  // Only ids actually on the menu are valid picks (and valid fallbacks), so the guard
  // can't be bypassed by the model returning a blocked id or the parser defaulting to one.
  const allowedIds = new Set(offered.map(([id]) => id));
  const menu = offered.map(([id, hint]) => `- ${id}: ${hint}`).join("\n");
  const defaultTemplate =
    offered.find(([id]) => ANCHOR_TEMPLATES.includes(id))?.[0] ?? offered[0]?.[0] ?? "drake";

  const avoidNote =
    recentTemplates.length > 0
      ? `\n\nRecently used templates (already excluded from the menu — do NOT ask for them): ${recentTemplates.join(", ")}. Vary the format.`
      : "";

  const system = `You write a single software-engineering humor meme for a Bluesky audience. Pick ONE meme template from the menu whose structure best fits the joke, write the on-image text, and a separate short Bluesky caption.

${SAFETY_CONSTRAINTS}

Rules:
- topText / bottomText are the words ON the image. Keep each short and punchy. If the template only needs one line, put it in topText and leave bottomText empty.
- caption is the Bluesky post text that accompanies the image — one relatable line, no hashtags (those go in the hashtags field).
- Style: dry, absurdist, or relatable-pain humor. Let the image carry the setup.
- reasoning: 1-2 sentences on why this template's structure fits the joke. Prefer a template that suits the joke over always reaching for the same one.
- themesReferenced: list the specific inputs you actually drew on for this meme (e.g. a trending theme, a current event, an audience or format note). Use [] if you only used the base topic. Quote the input briefly, do not invent new ones.
- hashtags: 3-5 Bluesky hashtags tailored to THIS meme's topic and themes (each starts with #, no spaces). Mix one or two broad discovery tags with more specific ones tied to the joke.

Respond with ONLY valid JSON, no markdown:
{ "template": "<one id from the menu>", "topText": "...", "bottomText": "...", "caption": "...", "reasoning": "...", "themesReferenced": ["..."], "hashtags": ["#..."] }`;

  const user = `Topic: ${topic}
Niche: ${styleLog.niche}${styleContext(styleLog)}${avoidNote}

Template menu (choose the id whose structure fits the joke best):
${menu}`;

  // Sonnet 4.6 for the creative spec — Haiku's jokes/templates were too repetitive.
  const text = await completeText({ system, user, maxTokens: 512, model: GENERATION_MODEL });
  const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

  let parsed: {
    template?: unknown;
    topText?: unknown;
    bottomText?: unknown;
    caption?: unknown;
    reasoning?: unknown;
    themesReferenced?: unknown;
    hashtags?: unknown;
  };
  try {
    parsed = JSON.parse(clean) as typeof parsed;
  } catch {
    console.warn("[meme-generator] could not parse meme spec — using a minimal default");
    parsed = {};
  }

  const template = typeof parsed.template === "string" && allowedIds.has(parsed.template)
    ? parsed.template
    : defaultTemplate;
  const topText = typeof parsed.topText === "string" ? parsed.topText : topic;
  const bottomText = typeof parsed.bottomText === "string" ? parsed.bottomText : "";
  const caption = typeof parsed.caption === "string" && parsed.caption.length > 0 ? parsed.caption : topic;
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  const themesReferenced = Array.isArray(parsed.themesReferenced)
    ? parsed.themesReferenced.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  const hashtags = normalizeHashtags(parsed.hashtags);

  return { template, topText, bottomText, caption, reasoning, themesReferenced, hashtags };
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
    reasoning: "Served from the approved fallback bank — live generation was unavailable.",
    themesReferenced: [],
    hashtags: [...DEFAULT_HASHTAGS],
  };
}

export interface GenerateOptions {
  // "mandatory" = a scheduled post (always allowed past the pacing cap). "exploratory"
  // = a creative/test generation, capped per day. Defaults to mandatory.
  type?: GenerationType;
  // Which generation path to use for THIS post. "magichour" routes to Magic Hour and
  // falls back to Memegen.link if the balance is depleted; "memegen" (default) uses
  // Memegen.link directly. The scheduler sets this per slot from the posting plan.
  generator?: Generator;
  // Legacy/back-compat alias for exploratory callers: equivalent to generator:"magichour".
  preferMagicHour?: boolean;
}

// Recently-used templates the next meme should avoid. Mem0 is the source of truth
// (the agent's own persistent memory); Postgres is the fallback when Mem0 is disabled
// or empty. Best-effort throughout — the guard is an optimization, never a blocker.
async function loadRecentTemplates(correlationId?: string): Promise<string[]> {
  try {
    const fromMem0 = await harnessedCall(
      { agentName: "meme-generator", action: "mem0-recall-templates", input: {}, correlationId, skipCircuitBreaker: true },
      () => recallRecentTemplates(RECENT_TEMPLATE_WINDOW)
    );
    if (fromMem0.length > 0) return fromMem0;
  } catch (err) {
    console.warn("[meme-generator] mem0 template recall failed, falling back to DB:", err instanceof Error ? err.message : err);
  }

  try {
    return await getRecentTemplates(NICHE, RECENT_TEMPLATE_WINDOW);
  } catch (err) {
    console.warn("[meme-generator] DB template recall failed — no recency guard this run:", err instanceof Error ? err.message : err);
    return [];
  }
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

  // Pull the recently-used templates so the generator can avoid repeating formats.
  const recentTemplates = await loadRecentTemplates(correlationId);
  if (recentTemplates.length > 0) {
    console.info(`[meme-generator] avoiding recently-used templates: ${recentTemplates.join(", ")}`);
  }

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
      () => generateMemeSpec(styleLog, topic, new Set(templates.keys()), recentTemplates, correlationId)
    );

    // Route to Magic Hour when the slot asks for it (generator:"magichour", or the
    // legacy preferMagicHour flag). Both scheduled and exploratory posts may use it;
    // it degrades to Memegen.link below if the balance is depleted.
    const useMagicHour = options?.generator === "magichour" || options?.preferMagicHour === true;

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

    return {
      imageUrl,
      caption: spec.caption,
      // Magic Hour picks its own image internally, so the Memegen template id doesn't
      // describe the post — record "magichour" to keep template stats clean. A Magic
      // Hour slot that fell back to Memegen records the actual Memegen template.
      templateUsed: generator === "magichour" ? "magichour" : spec.template,
      generator,
      topic,
      reasoning: spec.reasoning,
      themesReferenced: spec.themesReferenced,
      hashtags: spec.hashtags,
    };
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

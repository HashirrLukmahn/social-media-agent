// Magic Hour client — the SECONDARY meme-generation path, for EXPLORATORY slots
// only (never the 3 mandatory scheduled posts). Real generative AI, pay-per-call.
//
// Free tier = 100 images + daily-login top-ups (a manual, human action — the agent
// can't replenish it), so the balance can run out. Magic Hour has no balance-check
// endpoint, so we degrade REACTIVELY: a 402 "Payment required" from the generate
// call means depleted → the caller falls back to Memegen.link for that slot.
//
// The SDK's generate() auto-polls to completion, so this stays a single await — no
// webhook/polling on our side.

import { Client, ApiError } from "magic-hour";

// Templates the AI Meme Generator accepts (from docs.magichour.ai). "Random" lets
// Magic Hour choose — the right default for "novel format" exploratory generations.
const MAGIC_HOUR_TEMPLATES = [
  "Random", "Drake Hotline Bling", "Galaxy Brain", "Two Buttons", "Gru's Plan",
  "Tuxedo Winnie The Pooh", "Is This a Pigeon", "Panik Kalm Panik", "Disappointed Guy",
  "Waiting Skeleton", "Bike Fall", "Change My Mind", "Side Eyeing Chloe",
] as const;
type MagicHourTemplate = (typeof MAGIC_HOUR_TEMPLATES)[number];

function isMagicHourTemplate(t: string): t is MagicHourTemplate {
  return (MAGIC_HOUR_TEMPLATES as readonly string[]).includes(t);
}

// Thrown for the depleted-balance case so callers can branch cleanly.
export class MagicHourDepletedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MagicHourDepletedError";
  }
}

let client: Client | null = null;
let disabled = false;

function getClient(): Client | null {
  if (disabled) return null;
  if (client) return client;
  const token = process.env["MAGICHOUR_API_KEY"];
  if (!token) {
    console.warn("[magic-hour] MAGICHOUR_API_KEY not set — Magic Hour disabled");
    disabled = true;
    return null;
  }
  client = new Client({ token });
  return client;
}

// True when an error means "out of credits" — the signal to fall back to Memegen.
export function isDepletedError(err: unknown): boolean {
  if (err instanceof MagicHourDepletedError) return true;
  if (err instanceof ApiError) return err.response?.status === 402;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("payment required") || msg.includes("402");
}

// Generate an exploratory meme from a topic. Returns a (temporary) image URL.
// Throws MagicHourDepletedError on depleted balance, or another error otherwise.
export async function renderMagicHour(topic: string, template = "Random"): Promise<string> {
  // Test/sim hook (Step 5): force the depleted path without touching real balance.
  if (process.env["MAGICHOUR_FORCE_DEPLETED"] === "1") {
    throw new MagicHourDepletedError("forced depleted via MAGICHOUR_FORCE_DEPLETED");
  }

  const c = getClient();
  if (!c) throw new Error("Magic Hour disabled (no MAGICHOUR_API_KEY)");

  const chosen: MagicHourTemplate = isMagicHourTemplate(template) ? template : "Random";
  const res = await c.v1.aiMemeGenerator.generate(
    { name: "exploratory meme", style: { topic: topic.slice(0, 200), template: chosen, searchWeb: false } },
    { waitForCompletion: true, downloadOutputs: false }
  );

  const url = res.downloads?.[0]?.url;
  if (!url) throw new Error(`Magic Hour returned no image URL (status=${res.status ?? "?"})`);
  return url;
}

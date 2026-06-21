// Memegen.link client — the primary (default) meme-generation path.
//
// api.memegen.link is free, keyless, stateless: a single GET to
//   /images/{template}/{line1}/{line2}.png
// returns the finished image. No account, no credits, no webhook/polling.
//
// We fetch the template catalog once and cache it (to validate template ids and
// know each template's text-slot count), and encode line text per memegen's
// documented substitution scheme (NOT percent-encoding).

const API_BASE = "https://api.memegen.link";

export interface MemegenTemplate {
  id: string;
  name: string;
  lines: number; // number of text slots
}

// ── Text encoding (https://memegen.link/ — "special characters") ──────────────
// Order matters: double the literal _ and - first, then the ~-prefixed reserved
// chars, then quotes/newlines, then spaces → _ last.
export function encodeMemegenText(text: string): string {
  if (!text) return "_"; // empty slot
  return text
    .replace(/_/g, "__")
    .replace(/-/g, "--")
    .replace(/\?/g, "~q")
    .replace(/&/g, "~a")
    .replace(/%/g, "~p")
    .replace(/#/g, "~h")
    .replace(/\//g, "~s")
    .replace(/\\/g, "~b")
    .replace(/</g, "~l")
    .replace(/>/g, "~g")
    .replace(/"/g, "''")
    .replace(/\n/g, "~n")
    .replace(/ /g, "_");
}

// Build the image URL for a template + 1-2 lines of text. The URL *is* the image.
export function buildMemegenUrl(templateId: string, lines: string[]): string {
  const encoded = lines.slice(0, 2).map(encodeMemegenText);
  if (encoded.length === 0) encoded.push("_");
  return `${API_BASE}/images/${encodeURIComponent(templateId)}/${encoded.join("/")}.png`;
}

// ── Template catalog (fetched once, cached in-process) ────────────────────────
let templateCache: Map<string, MemegenTemplate> | null = null;

export async function getTemplates(): Promise<Map<string, MemegenTemplate>> {
  if (templateCache) return templateCache;
  const res = await fetch(`${API_BASE}/templates/`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`memegen templates ${res.status}: ${await res.text()}`);
  const raw = (await res.json()) as Array<{ id?: string; name?: string; lines?: number }>;
  const map = new Map<string, MemegenTemplate>();
  for (const t of raw) {
    if (typeof t.id === "string") {
      map.set(t.id, { id: t.id, name: t.name ?? t.id, lines: typeof t.lines === "number" ? t.lines : 2 });
    }
  }
  templateCache = map;
  return map;
}

// Render a meme: build the URL, then GET it to confirm it produces a real image.
// Returns the (live, permanent) image URL. Throws on a non-image / non-200 response
// so the caller can fall back. Wrap the call site in harnessedCall().
export async function renderMemegen(templateId: string, lines: string[]): Promise<string> {
  const url = buildMemegenUrl(templateId, lines);
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.startsWith("image")) {
    throw new Error(`memegen render failed (${res.status}, ${contentType}) for ${url}`);
  }
  return url;
}

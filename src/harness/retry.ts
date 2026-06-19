import type { RetryOptions } from "./types.js";

const DEFAULTS: Required<RetryOptions> = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
  // Optional abort check — called between retries. Lets the kill switch short-
  // circuit a retry loop that would otherwise wait out its full backoff window.
  shouldAbort?: () => Promise<boolean>
): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...options };

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;

      if (shouldAbort && (await shouldAbort())) {
        throw new Error("Aborted between retries (kill switch activated)");
      }

      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = Math.random() * 100;
      await sleep(delay + jitter);
    }
  }

  throw lastError;
}

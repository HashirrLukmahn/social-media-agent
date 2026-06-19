// Thin wrapper around Railway Redis. Every harness component reads/writes
// through this so there's exactly one place that knows about the connection.

import { createClient, type RedisClientType } from "redis";

const MAX_RECONNECT_RETRIES = 10;
const COMMAND_QUEUE_MAX = 100;

let client: RedisClientType | null = null;

// Exposed for unit tests to reset singleton state between test cases.
export function _resetClientForTesting(): void {
  client = null;
}

async function getClient(): Promise<RedisClientType> {
  if (client !== null) {
    // If the client exists but is not yet ready (reconnecting), redis queues
    // the command automatically — we don't need to wait here. The command will
    // execute once the connection is re-established or be rejected if the queue
    // fills past COMMAND_QUEUE_MAX.
    return client;
  }

  const url = process.env["REDIS_URL"];
  if (!url) {
    throw new Error("REDIS_URL is not set — Railway Redis must be provisioned");
  }

  client = createClient({
    url,
    socket: {
      // Exponential backoff: 0ms, 200ms, 400ms, ... capped at 5s.
      // Returns Error after MAX_RECONNECT_RETRIES to stop reconnecting and
      // emit an 'error' event — callers will then see their command rejected.
      reconnectStrategy: (retries) => {
        if (retries > MAX_RECONNECT_RETRIES) {
          const err = new Error(
            `Redis: max reconnect attempts (${MAX_RECONNECT_RETRIES}) exceeded — giving up`
          );
          console.error("[harness:store]", err.message);
          return err;
        }
        const delayMs = Math.min(retries * 200, 5000);
        console.warn(`[harness:store] Redis reconnecting in ${delayMs}ms (attempt ${retries})`);
        return delayMs;
      },
      connectTimeout: 10_000,
    },
    // Prevent unbounded memory growth during extended outages.
    // When the queue fills, new commands are rejected immediately.
    commandsQueueMaxLength: COMMAND_QUEUE_MAX,
  }) as RedisClientType;

  client.on("error", (err: Error) => {
    // Don't throw — a transient error shouldn't crash the process.
    // Commands issued while disconnected are either queued or fail immediately
    // if the queue is full; the harness retry logic handles that.
    console.error("[harness:store] redis error:", err.message);
  });

  client.on("reconnecting", () => {
    console.warn("[harness:store] redis connection lost, reconnecting...");
  });

  client.on("ready", () => {
    console.info("[harness:store] redis ready");
  });

  await client.connect();
  return client;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const c = await getClient();
  const raw = await c.get(key);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

export async function kvSet<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
  const c = await getClient();
  const serialized = JSON.stringify(value);
  if (ttlSeconds !== undefined) {
    await c.set(key, serialized, { EX: ttlSeconds });
  } else {
    await c.set(key, serialized);
  }
}

export async function kvAppend<T>(listKey: string, value: T, maxLen = 500): Promise<void> {
  const c = await getClient();
  await c.lPush(listKey, JSON.stringify(value));
  await c.lTrim(listKey, 0, maxLen - 1);
}

export async function kvList<T>(listKey: string, count = 50): Promise<T[]> {
  const c = await getClient();
  const raw = await c.lRange(listKey, 0, count - 1);
  return raw.map((r) => JSON.parse(r) as T);
}

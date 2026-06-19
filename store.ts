// harness/store.ts
//
// Thin wrapper around Railway Redis. Every harness component reads/writes
// through this so there's exactly one place that knows about the connection.

import { createClient, type RedisClientType } from "redis";

let client: RedisClientType | null = null;

async function getClient(): Promise<RedisClientType> {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not set — Railway Redis must be provisioned");
  }

  client = createClient({ url });
  client.on("error", (err) => {
    // Don't throw here — a transient Redis error shouldn't crash the process.
    // Callers will see failures on their next get/set and can handle it.
    console.error("[harness:store] redis client error", err);
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

export async function kvSet<T>(key: string, value: T): Promise<void> {
  const c = await getClient();
  await c.set(key, JSON.stringify(value));
}

export async function kvAppend<T>(listKey: string, value: T, maxLen = 500): Promise<void> {
  const c = await getClient();
  await c.lPush(listKey, JSON.stringify(value));
  // Trim so the log doesn't grow unbounded — keep most recent maxLen entries.
  await c.lTrim(listKey, 0, maxLen - 1);
}

export async function kvList<T>(listKey: string, count = 50): Promise<T[]> {
  const c = await getClient();
  const raw = await c.lRange(listKey, 0, count - 1);
  return raw.map((r) => JSON.parse(r) as T);
}

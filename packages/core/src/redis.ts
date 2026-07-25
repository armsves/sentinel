/**
 * Optional Upstash Redis REST backend so Vercel (serverless) and local
 * agents can share settings / queue / activity.
 *
 * Set:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

export function useRedisStore(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  );
}

async function redisCommand(args: Array<string | number>): Promise<unknown> {
  const base = process.env.UPSTASH_REDIS_REST_URL!.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  const res = await fetch(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || json.error) {
    throw new Error(json.error ?? `Upstash ${res.status}`);
  }
  return json.result;
}

export async function redisGet(key: string): Promise<string | null> {
  const result = await redisCommand(["GET", key]);
  return result == null ? null : String(result);
}

export async function redisSet(key: string, value: string): Promise<void> {
  await redisCommand(["SET", key, value]);
}

export async function redisLPush(key: string, value: string): Promise<void> {
  await redisCommand(["LPUSH", key, value]);
}

export async function redisLRange(
  key: string,
  start: number,
  stop: number,
): Promise<string[]> {
  const result = await redisCommand(["LRANGE", key, start, stop]);
  if (!Array.isArray(result)) return [];
  return result.map((v) => String(v));
}

export async function redisLTrim(
  key: string,
  start: number,
  stop: number,
): Promise<void> {
  await redisCommand(["LTRIM", key, start, stop]);
}

export async function redisDel(key: string): Promise<void> {
  await redisCommand(["DEL", key]);
}

export const REDIS_KEYS = {
  settings: "sentinel:settings",
  queue: "sentinel:panic-queue",
  activity: "sentinel:activity",
} as const;

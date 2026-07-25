import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import {
  REDIS_KEYS,
  redisLPush,
  redisLRange,
  redisLTrim,
  redisDel,
  useRedisStore,
} from "./redis.js";

export type ActivityAgent = "scanner" | "executor" | "api" | "demo" | "system";

export type ActivityEvent = {
  id: string;
  ts: number;
  agent: ActivityAgent;
  phase:
    | "heartbeat"
    | "detect"
    | "score"
    | "enqueue"
    | "withdraw"
    | "swap"
    | "transfer"
    | "policy"
    | "trigger"
    | "done"
    | "error"
    | "other";
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
};

function monorepoRoot(): string {
  const found = [
    process.cwd(),
    resolve(process.cwd(), "../.."),
    resolve(process.cwd(), "../../.."),
  ].find(
    (dir) =>
      existsSync(resolve(dir, "pnpm-workspace.yaml")) ||
      existsSync(resolve(dir, "pnpm-workspace.yml")),
  );
  return found ?? process.cwd();
}

function activityPath(): string {
  if (process.env.ACTIVITY_LOG_PATH) {
    return resolve(process.cwd(), process.env.ACTIVITY_LOG_PATH);
  }
  return resolve(monorepoRoot(), "data/activity.jsonl");
}

/** Append a live activity event for the dashboard feed. */
export async function emitActivity(
  partial: Omit<ActivityEvent, "id" | "ts"> & { id?: string; ts?: number },
): Promise<ActivityEvent> {
  const event: ActivityEvent = {
    id: partial.id ?? randomUUID().slice(0, 12),
    ts: partial.ts ?? Date.now(),
    agent: partial.agent,
    phase: partial.phase,
    level: partial.level,
    message: partial.message,
    data: partial.data,
  };

  try {
    if (useRedisStore()) {
      await redisLPush(REDIS_KEYS.activity, JSON.stringify(event));
      await redisLTrim(REDIS_KEYS.activity, 0, 199);
    } else {
      const path = activityPath();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(event)}\n`);
    }
  } catch (err) {
    logger.debug("activity emit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const logFn =
    event.level === "error"
      ? logger.error
      : event.level === "warn"
        ? logger.warn
        : logger.info;
  logFn(`[${event.agent}/${event.phase}] ${event.message}`, event.data);
  return event;
}

export async function listActivity(opts?: {
  since?: number;
  limit?: number;
}): Promise<ActivityEvent[]> {
  const limit = Math.min(500, Math.max(1, opts?.limit ?? 100));
  const since = opts?.since ?? 0;

  if (useRedisStore()) {
    const rows = await redisLRange(REDIS_KEYS.activity, 0, limit - 1);
    // LPUSH → newest first; reverse for chronological
    const events: ActivityEvent[] = [];
    for (const row of rows.reverse()) {
      try {
        const ev = JSON.parse(row) as ActivityEvent;
        if (ev.ts >= since) events.push(ev);
      } catch {
        /* skip */
      }
    }
    return events;
  }

  const path = activityPath();
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const events: ActivityEvent[] = [];
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
    try {
      const ev = JSON.parse(lines[i]!) as ActivityEvent;
      if (ev.ts >= since) events.push(ev);
    } catch {
      /* skip */
    }
  }
  return events.reverse();
}

export async function clearActivity(): Promise<void> {
  if (useRedisStore()) {
    await redisDel(REDIS_KEYS.activity);
    return;
  }
  const path = activityPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
}

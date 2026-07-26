import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { REDIS_KEYS, redisGet, redisSet, useRedisStore } from "./redis.js";

export type BotHeartbeat = {
  ts: number;
  startedAt: number;
  role: "bot" | "scanner" | "executor";
  pid: number;
};

export type BotPresence = {
  online: boolean;
  lastSeen: number | null;
  startedAt: number | null;
  role: BotHeartbeat["role"] | null;
  /** ms without a pulse before considered offline */
  staleAfterMs: number;
};

/** Default: 3× typical 15s scan interval. */
export const BOT_STALE_MS = 45_000;

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

function heartbeatPath(): string {
  if (process.env.BOT_HEARTBEAT_PATH) {
    return resolve(process.cwd(), process.env.BOT_HEARTBEAT_PATH);
  }
  return resolve(monorepoRoot(), "data/bot-heartbeat.json");
}

let processStartedAt = Date.now();

export async function pulseBotHeartbeat(
  role: BotHeartbeat["role"] = "bot",
): Promise<BotHeartbeat> {
  const beat: BotHeartbeat = {
    ts: Date.now(),
    startedAt: processStartedAt,
    role,
    pid: process.pid,
  };

  if (useRedisStore()) {
    await redisSet(REDIS_KEYS.botHeartbeat, JSON.stringify(beat));
    return beat;
  }

  const path = heartbeatPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(beat));
  await rename(tmp, path);
  return beat;
}

export async function readBotHeartbeat(): Promise<BotHeartbeat | null> {
  try {
    if (useRedisStore()) {
      const raw = await redisGet(REDIS_KEYS.botHeartbeat);
      if (!raw) return null;
      return JSON.parse(raw) as BotHeartbeat;
    }
    const raw = await readFile(heartbeatPath(), "utf8");
    return JSON.parse(raw) as BotHeartbeat;
  } catch {
    return null;
  }
}

export async function getBotPresence(
  staleAfterMs = BOT_STALE_MS,
): Promise<BotPresence> {
  const beat = await readBotHeartbeat();
  if (!beat?.ts) {
    return {
      online: false,
      lastSeen: null,
      startedAt: null,
      role: null,
      staleAfterMs,
    };
  }
  const age = Date.now() - beat.ts;
  return {
    online: age <= staleAfterMs,
    lastSeen: beat.ts,
    startedAt: beat.startedAt ?? null,
    role: beat.role ?? null,
    staleAfterMs,
  };
}

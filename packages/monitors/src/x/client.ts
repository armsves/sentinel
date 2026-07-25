import { readFile } from "node:fs/promises";
import { getConfig, logger } from "@sentinel/core";
import { BLOCKAID_VERUS_FIXTURE } from "./fixture.js";
import { postsToSignals, type XPost } from "./parse.js";
import type { NormalizedSignal } from "@sentinel/core";

const userIdCache = new Map<string, string>();

async function resolveUserId(
  username: string,
  bearer: string,
): Promise<string> {
  const cached = userIdCache.get(username.toLowerCase());
  if (cached) return cached;
  const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const json = (await res.json()) as {
    data?: { id: string };
    errors?: unknown;
  };
  if (!res.ok || !json.data?.id) {
    throw new Error(
      `X user lookup failed for @${username}: ${JSON.stringify(json.errors ?? json)}`,
    );
  }
  userIdCache.set(username.toLowerCase(), json.data.id);
  return json.data.id;
}

async function fetchUserTimeline(
  username: string,
  bearer: string,
  maxResults: number,
): Promise<XPost[]> {
  const userId = await resolveUserId(username, bearer);
  const n = Math.max(5, Math.min(100, maxResults));
  const params = new URLSearchParams({
    max_results: String(n),
    "tweet.fields": "created_at,entities",
    exclude: "replies,retweets",
  });
  const url = `https://api.x.com/2/users/${userId}/tweets?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const json = (await res.json()) as {
    data?: Array<{ id: string; text: string; created_at?: string }>;
    errors?: unknown;
  };
  if (!res.ok) {
    throw new Error(
      `X timeline failed for @${username}: ${JSON.stringify(json.errors ?? json)}`,
    );
  }
  return (json.data ?? []).map((t) => ({
    id: t.id,
    username,
    text: t.text,
    createdAt: t.created_at,
    url: `https://x.com/${username}/status/${t.id}`,
  }));
}

async function loadFixturePosts(): Promise<XPost[]> {
  const cfg = getConfig();
  if (cfg.X_FIXTURE_PATH) {
    const raw = await readFile(cfg.X_FIXTURE_PATH, "utf8");
    return JSON.parse(raw) as XPost[];
  }
  return BLOCKAID_VERUS_FIXTURE;
}

/**
 * Pull recent posts from watched X accounts (default: blockaid_).
 * Prefers X API v2 when X_BEARER_TOKEN is set; otherwise uses the built-in
 * Blockaid exploit fixture so parsing still works in demos.
 */
export async function fetchWatchedXPosts(): Promise<XPost[]> {
  const cfg = getConfig();
  if (!cfg.X_POLL_ENABLED) return [];

  const bearer = cfg.X_BEARER_TOKEN.trim();
  if (!bearer) {
    logger.warn("X_BEARER_TOKEN unset — using Blockaid fixture posts");
    return loadFixturePosts();
  }

  const all: XPost[] = [];
  for (const username of cfg.xWatchAccounts) {
    try {
      const posts = await fetchUserTimeline(username, bearer, cfg.X_MAX_POSTS);
      all.push(...posts);
    } catch (err) {
      logger.error(`failed to fetch @${username}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return all;
}

export async function pollXExploitSignals(): Promise<NormalizedSignal[]> {
  const posts = await fetchWatchedXPosts();
  const signals = postsToSignals(posts);
  logger.info("x monitor", {
    posts: posts.length,
    exploitSignals: signals.length,
    accounts: getConfig().xWatchAccounts,
  });
  return signals;
}

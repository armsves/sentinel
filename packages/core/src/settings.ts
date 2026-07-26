import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Severity } from "./types.js";
import { REDIS_KEYS, redisGet, redisSet, useRedisStore } from "./redis.js";

export type PolicySettings = {
  /** Ordered flight-to-safety assets */
  safeAssets: Array<"USDC" | "USDT" | "DAI">;
  /** Stop-loss style: token/pool price drop % that counts as a signal */
  priceDropThresholdPct: number;
  /** Stable peg deviation in basis points */
  depegThresholdBps: number;
  /** Pool TVL day-over-day drop % */
  poolTvlDropThresholdPct: number;
  poolMinTvlUsd: number;
  /** Distinct signal sources required before panic */
  panicConfirmations: number;
  /** Minimum severity that may enqueue a panic */
  minPanicSeverity: Severity;
  slippageTolerance: number;
  executionMode: "dry_run" | "live";
  actions: {
    withdrawLp: boolean;
    swapToStables: boolean;
    /** After flight-to-stables, ERC-20 transfer to SAFE_WALLET_ADDRESS */
    transferToSafe: boolean;
  };
  sources: {
    graph: boolean;
    x: boolean;
    glider: boolean;
    forta: boolean;
    zg: boolean;
  };
};

export const DEFAULT_POLICY: PolicySettings = {
  safeAssets: ["USDC", "USDT", "DAI"],
  priceDropThresholdPct: 15,
  depegThresholdBps: 100,
  poolTvlDropThresholdPct: 25,
  poolMinTvlUsd: 10,
  panicConfirmations: 2,
  minPanicSeverity: "high",
  slippageTolerance: 1,
  executionMode: "dry_run",
  actions: {
    withdrawLp: true,
    swapToStables: true,
    transferToSafe: true,
  },
  sources: {
    graph: true,
    x: true,
    glider: true,
    forta: false,
    zg: true,
  },
};

function settingsPath(): string {
  if (process.env.RUNTIME_SETTINGS_PATH) {
    return resolve(process.cwd(), process.env.RUNTIME_SETTINGS_PATH);
  }
  const monorepoRoot = [
    process.cwd(),
    resolve(process.cwd(), "../.."),
    resolve(process.cwd(), "../../.."),
  ].find(
    (dir) =>
      existsSync(resolve(dir, "pnpm-workspace.yaml")) ||
      existsSync(resolve(dir, "pnpm-workspace.yml")),
  );
  if (monorepoRoot) {
    return resolve(monorepoRoot, "data/runtime-settings.json");
  }
  return resolve(process.cwd(), "data/runtime-settings.json");
}

export async function loadPolicySettings(): Promise<PolicySettings> {
  try {
    if (useRedisStore()) {
      const raw = await redisGet(REDIS_KEYS.settings);
      if (!raw) {
        return {
          ...DEFAULT_POLICY,
          actions: { ...DEFAULT_POLICY.actions },
          sources: { ...DEFAULT_POLICY.sources },
          safeAssets: [...DEFAULT_POLICY.safeAssets],
        };
      }
      return mergePolicy(DEFAULT_POLICY, JSON.parse(raw) as Partial<PolicySettings>);
    }
    const raw = await readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PolicySettings>;
    return mergePolicy(DEFAULT_POLICY, parsed);
  } catch {
    return {
      ...DEFAULT_POLICY,
      actions: { ...DEFAULT_POLICY.actions },
      sources: { ...DEFAULT_POLICY.sources },
      safeAssets: [...DEFAULT_POLICY.safeAssets],
    };
  }
}

export function mergePolicy(
  base: PolicySettings,
  patch: Partial<PolicySettings>,
): PolicySettings {
  const safeAssets = (patch.safeAssets?.length
    ? patch.safeAssets
    : base.safeAssets
  ).filter((a): a is "USDC" | "USDT" | "DAI" =>
    ["USDC", "USDT", "DAI"].includes(a),
  );
  return {
    ...base,
    ...patch,
    safeAssets: safeAssets.length ? safeAssets : [...base.safeAssets],
    actions: {
      ...base.actions,
      ...(patch.actions ?? {}),
    },
    sources: { ...base.sources, ...(patch.sources ?? {}) },
  };
}

export async function savePolicySettings(
  patch: Partial<PolicySettings>,
): Promise<PolicySettings> {
  const current = await loadPolicySettings();
  const next = mergePolicy(current, patch);
  if (!next.safeAssets.length) next.safeAssets = ["USDC"];

  // Public Vercel demos stay dry_run unless explicitly unlocked
  if (
    (process.env.VERCEL || process.env.PUBLIC_DEMO === "true") &&
    process.env.ALLOW_PUBLIC_LIVE !== "true"
  ) {
    next.executionMode = "dry_run";
  }

  if (useRedisStore()) {
    await redisSet(REDIS_KEYS.settings, JSON.stringify(next));
    return next;
  }

  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await rename(tmp, path);
  return next;
}

export function severityRank(s: Severity): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[s];
}

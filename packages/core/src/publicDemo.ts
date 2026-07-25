import { randomUUID } from "node:crypto";
import { emitActivity } from "./activity.js";
import { getConfig } from "./config.js";
import {
  loadPolicySettings,
  savePolicySettings,
  type PolicySettings,
} from "./settings.js";
import { useRedisStore } from "./redis.js";

export type PublicTriggerKind = "stop_loss" | "depeg" | "tvl_drop" | "exploit";

export type PublicDemoPlanStep = {
  step: number;
  title: string;
  detail: string;
  status: "planned" | "done" | "skipped" | "failed";
};

export type PublicDemoResult = {
  scenario: PublicTriggerKind | "depeg" | "exploit" | "both";
  label: string;
  mode: "dry_run";
  event: {
    id: string;
    severity: string;
    zgScore: number;
    zgRationale: string;
  };
  executed: boolean;
  queueStatus: "done";
  plan: PublicDemoPlanStep[];
  safeWallet: string | null;
  publicDemo: true;
  store: "redis" | "memory";
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cloud-safe dry-run demo: no PRIVATE_KEY, no shell-out to executor.
 * Writes activity events (Redis when configured) so any visitor's dashboard
 * can watch the feed update.
 */
export async function runPublicDryRunDemo(opts: {
  kind: PublicTriggerKind | "depeg" | "exploit" | "both";
  value?: number;
  threshold?: number;
  saveThreshold?: boolean;
}): Promise<PublicDemoResult> {
  const policy = await loadPolicySettings();
  const cfg = getConfig();

  let threshold = opts.threshold;
  let value = opts.value;
  let label = String(opts.kind);

  if (opts.kind === "stop_loss") {
    threshold ??= policy.priceDropThresholdPct;
    value ??= threshold + Math.max(5, Math.round(threshold * 0.4));
    label = `Stop-loss ${value}% (threshold ${threshold}%)`;
    if (opts.saveThreshold) {
      await savePolicySettings({ priceDropThresholdPct: threshold });
    }
  } else if (opts.kind === "depeg" || opts.kind === "both") {
    threshold ??= policy.depegThresholdBps;
    value ??= threshold + 80;
    label =
      opts.kind === "both"
        ? `Depeg + exploit + Glider`
        : `Depeg ${value} bps (threshold ${threshold} bps)`;
    if (opts.saveThreshold && opts.kind === "depeg") {
      await savePolicySettings({ depegThresholdBps: threshold });
    }
  } else if (opts.kind === "tvl_drop") {
    threshold ??= policy.poolTvlDropThresholdPct;
    value ??= threshold + Math.max(5, Math.round(threshold * 0.4));
    label = `TVL drop ${value}% (threshold ${threshold}%)`;
    if (opts.saveThreshold) {
      await savePolicySettings({ poolTvlDropThresholdPct: threshold });
    }
  } else {
    label = "Exploit / drain alert";
  }

  const id = `public-${opts.kind}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const pool = cfg.watchedPools[0] ?? "watched-pool";
  const safe = cfg.SAFE_WALLET_ADDRESS || null;

  await emitActivity({
    agent: "demo",
    phase: "trigger",
    level: "warn",
    message: `Public demo: ${label}`,
    data: { id, kind: opts.kind, value, threshold },
  });
  await sleep(200);

  await emitActivity({
    agent: "demo",
    phase: "detect",
    level: "warn",
    message: `Signal on pool ${pool}: ${label}`,
  });
  await sleep(250);

  const zgScore = 0.91;
  const zgRationale = `Public dry-run: ${label} exceeds policy thresholds.`;
  await emitActivity({
    agent: "demo",
    phase: "score",
    level: "warn",
    message: `0G score ${zgScore} — ${zgRationale}`,
    data: { provider: "public-demo" },
  });
  await sleep(200);

  await emitActivity({
    agent: "demo",
    phase: "enqueue",
    level: "warn",
    message: `Panic enqueued ${id} (dry_run)`,
  });
  await sleep(200);

  if (policy.actions.withdrawLp) {
    await emitActivity({
      agent: "executor",
      phase: "withdraw",
      level: "info",
      message: "[dry_run] would withdraw Uniswap LP 100%",
      data: { pool },
    });
    await sleep(300);
  }

  if (policy.actions.swapToStables) {
    await emitActivity({
      agent: "executor",
      phase: "swap",
      level: "warn",
      message: `[dry_run] would swap residuals → ${policy.safeAssets.join(",")}`,
    });
    await sleep(300);
  }

  if (policy.actions.transferToSafe) {
    await emitActivity({
      agent: "executor",
      phase: "transfer",
      level: "warn",
      message: safe
        ? `[dry_run] would transfer stables → ${safe}`
        : "[dry_run] SAFE_WALLET unset — would keep stables on hot wallet",
    });
    await sleep(200);
  }

  await emitActivity({
    agent: "executor",
    phase: "done",
    level: "warn",
    message: `Public dry-run completed ${id}`,
  });

  const plan: PublicDemoPlanStep[] = [
    {
      step: 1,
      title: "Detect incident",
      detail: label,
      status: "done",
    },
    {
      step: 2,
      title: "Score with 0G",
      detail: `score=${zgScore} — ${zgRationale}`,
      status: "done",
    },
    {
      step: 3,
      title: "Enqueue panic",
      detail: `id=${id} · mode=dry_run`,
      status: "done",
    },
    {
      step: 4,
      title: "Withdraw Uniswap LP",
      detail: policy.actions.withdrawLp
        ? "[dry_run] decrease liquidity 100%"
        : "Disabled in policy",
      status: policy.actions.withdrawLp ? "done" : "skipped",
    },
    {
      step: 5,
      title: "Swap residuals → stables",
      detail: policy.actions.swapToStables
        ? `[dry_run] → ${policy.safeAssets.join(" → ")}`
        : "Disabled in policy",
      status: policy.actions.swapToStables ? "done" : "skipped",
    },
    {
      step: 6,
      title: "Transfer to safe wallet",
      detail: policy.actions.transferToSafe
        ? safe
          ? `[dry_run] → ${safe}`
          : "SAFE_WALLET unset"
        : "Disabled in policy",
      status:
        policy.actions.transferToSafe && safe ? "done" : "skipped",
    },
  ];

  return {
    scenario: opts.kind,
    label,
    mode: "dry_run",
    event: {
      id,
      severity: "critical",
      zgScore,
      zgRationale,
    },
    executed: true,
    queueStatus: "done",
    plan,
    safeWallet: safe,
    publicDemo: true,
    store: useRedisStore() ? "redis" : "memory",
  };
}

/** True when running on Vercel / public cloud demo (no local executor). */
export function isPublicDemoRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.PUBLIC_DEMO === "true");
}

export type { PolicySettings };

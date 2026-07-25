import {
  buildPanicEvent,
  emitActivity,
  enqueuePanic,
  getConfig,
  getEffectiveConfig,
  listQueue,
  loadPolicySettings,
  type NormalizedSignal,
  type PanicEvent,
} from "@sentinel/core";
import {
  buildDemoSignals,
  buildTriggerSignals,
  demoScenarioLabel,
  type DemoScenario,
  type TriggerKind,
} from "@sentinel/monitors";
import { scoreSignalsWith0G } from "@sentinel/zg";
import { processOnePanic } from "./panicWorker.js";

export type DemoPlanStep = {
  step: number;
  title: string;
  detail: string;
  status: "planned" | "done" | "skipped" | "failed";
};

export type DemoRunResult = {
  scenario: DemoScenario | TriggerKind;
  label: string;
  mode: "dry_run" | "live";
  event: PanicEvent;
  zg: Awaited<ReturnType<typeof scoreSignalsWith0G>>;
  enqueued: boolean;
  executed: boolean;
  queueStatus?: string;
  plan: DemoPlanStep[];
  safeWallet: string | null;
};

function buildPlan(opts: {
  event: PanicEvent;
  policy: Awaited<ReturnType<typeof loadPolicySettings>>;
  cfg: Awaited<ReturnType<typeof getEffectiveConfig>>;
  executed: boolean;
  queueStatus?: string;
}): DemoPlanStep[] {
  const { event, policy, cfg, executed, queueStatus } = opts;
  const done = executed && queueStatus === "done";
  const failed = executed && queueStatus === "failed";
  const mark = (ok: boolean): DemoPlanStep["status"] => {
    if (!executed) return "planned";
    if (failed) return "failed";
    if (done && ok) return "done";
    if (done && !ok) return "skipped";
    return "planned";
  };

  return [
    {
      step: 1,
      title: "Detect incident",
      detail: event.reasons.map((r) => `[${r.source}] ${r.signal}`).join(" · "),
      status: "done",
    },
    {
      step: 2,
      title: "Score with 0G",
      detail: `score=${event.zgScore ?? "n/a"} — ${event.zgRationale ?? "no rationale"}`,
      status: "done",
    },
    {
      step: 3,
      title: "Enqueue panic",
      detail: `id=${event.id} · positions=${event.positions.length} · stables=${event.targetStables.join(",")}`,
      status: "done",
    },
    {
      step: 4,
      title: "Withdraw Uniswap LP",
      detail: policy.actions.withdrawLp
        ? `Decrease liquidity 100% on watched / owned positions (chain ${cfg.CHAIN_ID})`
        : "Disabled in policy",
      status: mark(policy.actions.withdrawLp),
    },
    {
      step: 5,
      title: "Swap residuals → stables",
      detail: policy.actions.swapToStables
        ? `Route non-stables to ${event.targetStables.join(" → ")}`
        : "Disabled in policy",
      status: mark(policy.actions.swapToStables),
    },
    {
      step: 6,
      title: "Transfer to safe wallet",
      detail: policy.actions.transferToSafe
        ? cfg.SAFE_WALLET_ADDRESS
          ? `Send stables to ${cfg.SAFE_WALLET_ADDRESS}`
          : "SAFE_WALLET_ADDRESS unset — skipped"
        : "Disabled in policy",
      status: mark(
        policy.actions.transferToSafe && Boolean(cfg.SAFE_WALLET_ADDRESS),
      ),
    },
  ];
}

async function runWithSignals(opts: {
  scenario: DemoScenario | TriggerKind;
  label: string;
  signals: NormalizedSignal[];
  execute: boolean;
}): Promise<DemoRunResult> {
  const { scenario, label, signals, execute } = opts;
  const cfg = await getEffectiveConfig();
  const policy = await loadPolicySettings();

  await emitActivity({
    agent: "demo",
    phase: "trigger",
    level: "warn",
    message: `Incident injected: ${label}`,
    data: { scenario, mode: policy.executionMode, signals: signals.length },
  });

  await emitActivity({
    agent: "demo",
    phase: "detect",
    level: "info",
    message: signals.map((s) => s.message).join(" | ").slice(0, 280),
  });

  const zg = await scoreSignalsWith0G(signals);
  await emitActivity({
    agent: "demo",
    phase: "score",
    level: "warn",
    message: `0G score ${zg.score} — ${zg.rationale}`,
    data: { provider: zg.provider, shouldPanic: zg.shouldPanic },
  });

  const base = getConfig();
  const positions = base.watchedPools.map((pool) => ({
    chainId: base.CHAIN_ID,
    pool,
    tokens: [base.SUSD_ADDRESS, base.USDC_ADDRESS].filter(Boolean),
  }));

  let event = await buildPanicEvent(signals, {
    positions,
    zgScore: Math.max(zg.score, 0.9),
    zgRationale: zg.rationale,
    zgShouldPanic: true,
  });

  if (!event) {
    event = {
      id: `demo-fallback-${Date.now().toString(36)}`,
      ts: Date.now(),
      severity: "critical",
      reasons: signals.map((s) => ({
        source: s.source,
        signal: s.message,
        evidence: {
          category: s.category,
          tokens: s.tokens,
          addresses: s.addresses,
        },
      })),
      positions,
      targetStables: policy.safeAssets,
      mode: policy.executionMode,
      zgScore: Math.max(zg.score, 0.9),
      zgRationale: zg.rationale ?? "demo override",
    };
  }

  event.id = `demo-${scenario}-${Date.now().toString(36)}-${event.id.slice(-8)}`;
  event.mode = policy.executionMode;

  const enqueued = await enqueuePanic(event, { force: true });
  if (!enqueued) throw new Error("Failed to enqueue demo panic");

  await emitActivity({
    agent: "demo",
    phase: "enqueue",
    level: "warn",
    message: `Panic enqueued ${event.id}`,
    data: { execute },
  });

  let queueStatus: string | undefined;
  if (execute) {
    await processOnePanic();
    const items = await listQueue();
    queueStatus = items.find((i) => i.event.id === event!.id)?.status;
  }

  const plan = buildPlan({
    event,
    policy,
    cfg,
    executed: execute,
    queueStatus,
  });

  return {
    scenario,
    label,
    mode: event.mode,
    event,
    zg,
    enqueued,
    executed: execute,
    queueStatus,
    plan,
    safeWallet: cfg.SAFE_WALLET_ADDRESS || null,
  };
}

export async function runPresentationDemo(opts?: {
  scenario?: DemoScenario;
  execute?: boolean;
}): Promise<DemoRunResult> {
  const scenario = opts?.scenario ?? "depeg";
  return runWithSignals({
    scenario,
    label: demoScenarioLabel(scenario),
    signals: buildDemoSignals(scenario),
    execute: opts?.execute !== false,
  });
}

export async function runThresholdTrigger(opts: {
  kind: TriggerKind;
  value: number;
  threshold: number;
  execute?: boolean;
}): Promise<DemoRunResult> {
  const label =
    opts.kind === "stop_loss"
      ? `Stop-loss ${opts.value}% (threshold ${opts.threshold}%)`
      : opts.kind === "depeg"
        ? `Depeg ${opts.value} bps (threshold ${opts.threshold} bps)`
        : opts.kind === "tvl_drop"
          ? `TVL drop ${opts.value}% (threshold ${opts.threshold}%)`
          : "Exploit alert";

  return runWithSignals({
    scenario: opts.kind,
    label,
    signals: buildTriggerSignals({
      kind: opts.kind,
      value: opts.value,
      threshold: opts.threshold,
    }),
    execute: opts.execute !== false,
  });
}

export function printDemoResult(result: DemoRunResult) {
  const line = (s: string) => console.log(s);
  line("");
  line("══════════════════════════════════════════════════");
  line("  SENTINEL — presentation demo");
  line("══════════════════════════════════════════════════");
  line(`  Scenario : ${result.label}`);
  line(`  Mode     : ${result.mode}`);
  line(`  Panic id : ${result.event.id}`);
  line(`  0G score : ${result.zg.score} (${result.zg.provider})`);
  line(`  Safe     : ${result.safeWallet ?? "(unset)"}`);
  line("──────────────────────────────────────────────────");
  for (const step of result.plan) {
    const icon =
      step.status === "done"
        ? "✓"
        : step.status === "failed"
          ? "✗"
          : step.status === "skipped"
            ? "·"
            : "○";
    line(`  ${icon} ${step.step}. ${step.title}`);
    line(`     ${step.detail.slice(0, 160)}`);
  }
  line("──────────────────────────────────────────────────");
  if (result.executed) {
    line(`  Worker   : ${result.queueStatus ?? "unknown"}`);
  } else {
    line("  Worker   : not run (enqueue only)");
  }
  line("══════════════════════════════════════════════════");
  line("");
}

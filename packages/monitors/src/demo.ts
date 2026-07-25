import { getConfig, type NormalizedSignal } from "@sentinel/core";
import { BLOCKAID_VERUS_FIXTURE } from "./x/fixture.js";
import { postsToSignals } from "./x/parse.js";
import { GLIDER_FIXTURE, normalizeGliderWebhook } from "./glider.js";

export type DemoScenario = "depeg" | "exploit" | "both";

export type TriggerKind = "stop_loss" | "depeg" | "tvl_drop" | "exploit";

/** Presentation-grade fixtures: clearly narratable, tied to watched sUSD pool. */
export function buildDemoSignals(scenario: DemoScenario): NormalizedSignal[] {
  const cfg = getConfig();
  const pool =
    cfg.watchedPools[0] ?? "0x68eB6856e570e2c33A7239D0fF8C5d9A77Cecd8b";
  const susd = cfg.SUSD_ADDRESS || "0xC084E80E4E546561f4348198ebfC1fe7b714DB37";
  const usdc = cfg.USDC_ADDRESS;
  const now = new Date().toISOString();

  const depegPosts = [
    {
      id: `demo-depeg-${Date.now()}`,
      username: "blockaid_",
      createdAt: now,
      url: "https://x.com/blockaid_/status/demo-depeg",
      text:
        `🚨 DEMO / Blockaid: sUSD depegged on Uniswap v3 pool ${pool}. ` +
        `Peg vs USDC broken (~${cfg.DEPEG_THRESHOLD_BPS + 80} bps). ` +
        `Token ${susd}. USDC ${usdc}. Sentinel should exit LP and flight to stables.`,
    },
  ];

  const exploitPosts = [
    {
      id: `demo-exploit-${Date.now()}`,
      username: "blockaid_",
      createdAt: now,
      url: "https://x.com/blockaid_/status/demo-exploit",
      text:
        `🚨 DEMO / Blockaid: suspected exploit / drain path on sUSD-USDC. ` +
        `Watched pool ${pool} and token ${susd}. Treat as critical until cleared.`,
    },
  ];

  const out: NormalizedSignal[] = [];
  if (scenario === "depeg" || scenario === "both") {
    out.push(...postsToSignals(depegPosts));
  }
  if (scenario === "exploit" || scenario === "both") {
    out.push(...postsToSignals(exploitPosts));
  }
  if (scenario === "both") {
    out.push(normalizeGliderWebhook(GLIDER_FIXTURE));
  }
  if (!out.length) {
    out.push(...postsToSignals(BLOCKAID_VERUS_FIXTURE.slice(0, 1)));
  }
  return out;
}

export function demoScenarioLabel(scenario: DemoScenario): string {
  if (scenario === "depeg") return "sUSD depeg (Blockaid/X)";
  if (scenario === "exploit") return "sUSD exploit / drain (Blockaid/X)";
  return "Depeg + exploit + Glider";
}

/**
 * Build Graph-style breach signals from dashboard trigger params
 * (stop-loss %, depeg bps, TVL drop %).
 */
export function buildTriggerSignals(opts: {
  kind: TriggerKind;
  value: number;
  threshold: number;
}): NormalizedSignal[] {
  const cfg = getConfig();
  const pool =
    cfg.watchedPools[0] ?? "0x68eB6856e570e2c33A7239D0fF8C5d9A77Cecd8b";
  const susd = cfg.SUSD_ADDRESS || "0xC084E80E4E546561f4348198ebfC1fe7b714DB37";
  const usdc = cfg.USDC_ADDRESS;
  const ts = Date.now();

  if (opts.kind === "exploit") {
    return buildDemoSignals("exploit");
  }

  if (opts.kind === "stop_loss") {
    return [
      {
        source: "graph",
        severity: "critical",
        addresses: [pool, susd, usdc].filter(Boolean),
        tokens: ["SUSD", "USDC"],
        category: "price",
        message: `Stop-loss triggered: sUSD price dropped ${opts.value.toFixed(1)}% (threshold ${opts.threshold}%) on pool ${pool}`,
        raw: {
          kind: "stop_loss",
          value: opts.value,
          threshold: opts.threshold,
          pool,
          trigger: "dashboard",
        },
        ts,
      },
      ...buildDemoSignals("depeg").slice(0, 1),
    ];
  }

  if (opts.kind === "depeg") {
    return [
      {
        source: "graph",
        severity: "critical",
        addresses: [pool, susd, usdc].filter(Boolean),
        tokens: ["SUSD", "USDC"],
        category: "depeg",
        message: `Depeg triggered: sUSD/USDC deviation ${opts.value.toFixed(0)} bps (threshold ${opts.threshold} bps) on pool ${pool}`,
        raw: {
          kind: "depeg",
          value: opts.value,
          threshold: opts.threshold,
          pool,
          trigger: "dashboard",
        },
        ts,
      },
      ...buildDemoSignals("depeg").slice(0, 1),
    ];
  }

  return [
    {
      source: "graph",
      severity: "high",
      addresses: [pool, susd, usdc].filter(Boolean),
      tokens: ["SUSD", "USDC"],
      category: "pool_health",
      message: `TVL drop triggered: pool TVL fell ${opts.value.toFixed(1)}% (threshold ${opts.threshold}%) on ${pool}`,
      raw: {
        kind: "tvl_drop",
        value: opts.value,
        threshold: opts.threshold,
        pool,
        trigger: "dashboard",
      },
      ts,
    },
    ...buildDemoSignals("exploit").slice(0, 1),
  ];
}

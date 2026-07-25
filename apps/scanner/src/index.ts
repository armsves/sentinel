import {
  buildPanicEvent,
  createClients,
  enqueuePanic,
  getConfig,
  loadPolicySettings,
  logger,
  type NormalizedSignal,
} from "@sentinel/core";
import {
  fetchPoolHealthByIds,
  fetchPoolsForPortfolioTokens,
  fetchPortfolioTokens,
  poolHealthToSignals,
} from "@sentinel/graph";
import { pollFortaAlerts, pollXExploitSignals } from "@sentinel/monitors";
import { scoreSignalsWith0G } from "@sentinel/zg";
import { formatUnits } from "viem";

async function scanGraph(): Promise<{
  signals: NormalizedSignal[];
  heldSymbols: Set<string>;
}> {
  const cfg = getConfig();
  const { publicClient, address } = createClients();
  if (!address) {
    throw new Error(
      "Set WALLET_ADDRESS or PRIVATE_KEY so scanner knows the portfolio owner",
    );
  }

  const portfolioAddrs = (
    cfg.portfolioTokens.length
      ? cfg.portfolioTokens
      : [cfg.USDC_ADDRESS, cfg.USDT_ADDRESS, cfg.DAI_ADDRESS]
  ) as `0x${string}`[];

  const portfolio = await fetchPortfolioTokens({
    publicClient,
    owner: address,
    tokenAddresses: portfolioAddrs,
  });

  logger.info("portfolio snapshot", {
    owner: address,
    tokens: portfolio.map((t) => ({
      symbol: t.symbol,
      balance: formatUnits(BigInt(t.balanceRaw), t.decimals),
      address: t.address,
    })),
  });

  const held = portfolio
    .filter((t) => BigInt(t.balanceRaw) > 0n)
    .map((t) => t.address);
  const tokenUniverse = held.length ? held : portfolioAddrs;
  const heldSymbols = new Set(
    portfolio
      .filter((t) => BigInt(t.balanceRaw) > 0n)
      .map((t) => t.symbol.toUpperCase()),
  );

  let pools =
    cfg.watchedPools.length > 0
      ? await fetchPoolHealthByIds(cfg.watchedPools)
      : await fetchPoolsForPortfolioTokens(tokenUniverse);

  if (cfg.watchedPools.length && held.length) {
    const byToken = await fetchPoolsForPortfolioTokens(tokenUniverse);
    const seen = new Set(pools.map((p) => p.poolAddress));
    for (const p of byToken) {
      if (!seen.has(p.poolAddress)) pools.push(p);
    }
  }

  logger.info("pool health", {
    count: pools.length,
    unhealthy: pools.filter((p) => !p.healthy).length,
    sample: pools.slice(0, 5).map((p) => ({
      pool: p.poolAddress,
      pair: `${p.token0.symbol}/${p.token1.symbol}`,
      tvlUsd: Math.round(p.tvlUsd),
      healthy: p.healthy,
      issues: p.issues,
    })),
  });

  return { signals: poolHealthToSignals(pools), heldSymbols };
}

function relevanceBoost(
  signals: NormalizedSignal[],
  heldSymbols: Set<string>,
  watchedPools: string[],
): NormalizedSignal[] {
  const watched = new Set(watchedPools.map((p) => p.toLowerCase()));
  return signals.map((s) => {
    const tokenHit = (s.tokens ?? []).some((t) =>
      heldSymbols.has(t.toUpperCase()),
    );
    const addrHit = s.addresses.some((a) => watched.has(a.toLowerCase()));
    if (!tokenHit && !addrHit) return s;
    return {
      ...s,
      severity:
        s.severity === "critical"
          ? s.severity
          : s.severity === "high"
            ? "critical"
            : "high",
      message: `${s.message} [matches portfolio/watched]`,
    };
  });
}

async function scanOnce(): Promise<NormalizedSignal[]> {
  const cfg = getConfig();
  const policy = await loadPolicySettings();
  const graphPart = policy.sources.graph
    ? await scanGraph().catch((err) => {
        logger.error("graph scan failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          signals: [] as NormalizedSignal[],
          heldSymbols: new Set<string>(),
        };
      })
    : { signals: [] as NormalizedSignal[], heldSymbols: new Set<string>() };

  const xSignals = policy.sources.x
    ? await pollXExploitSignals().catch((err) => {
        logger.error("x scan failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as NormalizedSignal[];
      })
    : [];

  const fortaSignals = policy.sources.forta ? await pollFortaAlerts() : [];

  const boostedX = relevanceBoost(
    xSignals,
    graphPart.heldSymbols,
    cfg.watchedPools,
  );

  return [...graphPart.signals, ...boostedX, ...fortaSignals];
}

async function maybeEnqueuePanic(signals: NormalizedSignal[]) {
  const policy = await loadPolicySettings();
  const zg = policy.sources.zg
    ? await scoreSignalsWith0G(signals)
    : {
        score: 0,
        shouldPanic: false,
        severity: "low" as const,
        rationale: "0G scoring disabled in settings",
        whichSourcesMatter: [] as string[],
        provider: "heuristic-fallback" as const,
      };
  logger.info("0G risk score", {
    provider: zg.provider,
    score: zg.score,
    shouldPanic: zg.shouldPanic,
    severity: zg.severity,
    rationale: zg.rationale,
  });
  const event = await buildPanicEvent(signals, {
    zgScore: zg.score,
    zgRationale: zg.rationale,
    zgShouldPanic: zg.shouldPanic,
  });
  if (!event) return;
  const added = await enqueuePanic(event);
  if (added) {
    logger.warn("panic enqueued", {
      id: event.id,
      severity: event.severity,
      sources: event.reasons.map((r) => r.source),
      mode: event.mode,
      zgScore: event.zgScore,
    });
  } else {
    logger.info("panic suppressed (duplicate/cooldown)", {
      fingerprint: event.id,
    });
  }
}

async function main() {
  const cfg = getConfig();
  logger.info("scanner starting", {
    chainId: cfg.CHAIN_ID,
    intervalMs: cfg.SCAN_INTERVAL_MS,
    mode: cfg.EXECUTION_MODE,
    subgraph: cfg.GRAPH_UNISWAP_SUBGRAPH,
    xAccounts: cfg.xWatchAccounts,
    xFixture: !cfg.X_BEARER_TOKEN,
  });

  const tick = async () => {
    try {
      const signals = await scanOnce();
      const bySource = signals.reduce<Record<string, number>>((acc, s) => {
        acc[s.source] = (acc[s.source] ?? 0) + 1;
        return acc;
      }, {});
      if (signals.length) {
        logger.warn("active signals", {
          count: signals.length,
          bySource,
          messages: signals.map(
            (s) => `[${s.source}/${s.severity}] ${s.message}`,
          ),
        });
        await maybeEnqueuePanic(signals);
      } else {
        logger.info("no active signals");
      }
    } catch (err) {
      logger.error("scan failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await tick();
  setInterval(tick, cfg.SCAN_INTERVAL_MS);
}

main().catch((err) => {
  logger.error("scanner crashed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

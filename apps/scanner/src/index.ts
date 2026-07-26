import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPanicEvent,
  createClients,
  enqueuePanic,
  getConfig,
  loadPolicySettings,
  logger,
  pulseBotHeartbeat,
  type NormalizedSignal,
  type PanicEvent,
} from "@sentinel/core";
import {
  fetchPoolHealthByIds,
  fetchPoolsForPortfolioTokens,
  fetchPortfolioTokens,
  poolHealthToSignals,
} from "@sentinel/graph";
import { pollFortaAlerts, pollXExploitSignals } from "@sentinel/monitors";
import { listOwnerPositions } from "@sentinel/uniswap";
import { scoreSignalsWith0G } from "@sentinel/zg";
import { formatUnits } from "viem";

async function scanGraph(): Promise<{
  signals: NormalizedSignal[];
  heldSymbols: Set<string>;
  positions: PanicEvent["positions"];
}> {
  const cfg = getConfig();
  const { publicClient, address } = createClients();
  if (!address) {
    throw new Error(
      "Set WALLET_ADDRESS or PRIVATE_KEY so scanner knows the portfolio owner",
    );
  }

  const portfolioAddrs = [
    ...(cfg.portfolioTokens.length
      ? cfg.portfolioTokens
      : [cfg.USDC_ADDRESS, cfg.USDT_ADDRESS, cfg.DAI_ADDRESS]),
    ...(cfg.SUSD_ADDRESS ? [cfg.SUSD_ADDRESS] : []),
  ] as `0x${string}`[];
  const uniquePortfolio = [
    ...new Set(portfolioAddrs.map((a) => a.toLowerCase())),
  ] as `0x${string}`[];

  const portfolio = await fetchPortfolioTokens({
    publicClient,
    owner: address,
    tokenAddresses: uniquePortfolio,
  });

  logger.info("portfolio snapshot", { owner: address });
  for (const t of portfolio) {
    const bal = formatUnits(BigInt(t.balanceRaw), t.decimals);
    logger.info(`token  ${t.symbol.padEnd(8)} ${bal}`, {
      address: t.address,
    });
  }

  const held = portfolio
    .filter((t) => BigInt(t.balanceRaw) > 0n)
    .map((t) => t.address);
  const tokenUniverse = held.length ? held : uniquePortfolio;
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
  });
  const unhealthy = pools.filter((p) => !p.healthy);
  if (unhealthy.length) {
    logger.signals(
      `${unhealthy.length} unhealthy pool(s)`,
      unhealthy.map((p) => ({
        source: "graph",
        severity: p.issues.some((i) => /depeg|stop-loss|dropped|zero/i.test(i))
          ? "high"
          : "medium",
        category: p.issues.some((i) => /depeg/i.test(i))
          ? "depeg"
          : p.issues.some((i) => /stop-loss|price/i.test(i))
            ? "price"
            : "pool_health",
        message: `${p.token0.symbol}/${p.token1.symbol} TVL $${Math.round(p.tvlUsd)} — ${p.issues.join("; ")}`,
      })),
    );
  } else {
    for (const p of pools.slice(0, 5)) {
      logger.info(
        `pool ok  ${p.token0.symbol}/${p.token1.symbol}  TVL $${Math.round(p.tvlUsd)}`,
        { pool: p.poolAddress },
      );
    }
  }

  const ownerPositions = await listOwnerPositions(publicClient, address).catch(
    (err: unknown) => {
      logger.warn("position list failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [] as Awaited<ReturnType<typeof listOwnerPositions>>;
    },
  );
  const watchedNft = new Set(cfg.watchedPositionIds);
  const tracked =
    watchedNft.size > 0
      ? ownerPositions.filter(
          (p) => p.nftTokenId && watchedNft.has(p.nftTokenId),
        )
      : ownerPositions;

  const positions: PanicEvent["positions"] = tracked.map((p) => ({
    chainId: cfg.CHAIN_ID,
    pool: p.poolAddress,
    positionId: p.nftTokenId,
    tokens: [p.token0Address, p.token1Address],
  }));

  // Also attach watched pools even without an NFT (token trackers)
  for (const poolId of cfg.watchedPools) {
    if (positions.some((pos) => pos.pool?.toLowerCase() === poolId.toLowerCase())) {
      continue;
    }
    const health = pools.find(
      (pool) => pool.poolAddress.toLowerCase() === poolId.toLowerCase(),
    );
    positions.push({
      chainId: cfg.CHAIN_ID,
      pool: poolId,
      tokens: health
        ? [health.token0.address, health.token1.address]
        : uniquePortfolio.slice(0, 2),
    });
  }

  logger.info("tracked positions", {
    count: positions.length,
    nfts: positions.map((p) => p.positionId).filter(Boolean),
  });

  return {
    signals: poolHealthToSignals(pools),
    heldSymbols,
    positions,
  };
}

function relevanceBoost(
  signals: NormalizedSignal[],
  heldSymbols: Set<string>,
  watchedPools: string[],
  watchedAddresses: string[],
): NormalizedSignal[] {
  const watched = new Set([
    ...watchedPools.map((p) => p.toLowerCase()),
    ...watchedAddresses.map((a) => a.toLowerCase()),
  ]);
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

async function scanOnce(): Promise<{
  signals: NormalizedSignal[];
  positions: PanicEvent["positions"];
}> {
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
          positions: [] as PanicEvent["positions"],
        };
      })
    : {
        signals: [] as NormalizedSignal[],
        heldSymbols: new Set<string>(),
        positions: [] as PanicEvent["positions"],
      };

  const xSignals = policy.sources.x
    ? await pollXExploitSignals().catch((err) => {
        logger.error("x scan failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as NormalizedSignal[];
      })
    : [];

  const fortaSignals = policy.sources.forta ? await pollFortaAlerts() : [];

  const watchAddrs = [
    ...cfg.portfolioTokens,
    cfg.SUSD_ADDRESS,
    cfg.USDC_ADDRESS,
  ].filter(Boolean);

  const boostedX = relevanceBoost(
    xSignals,
    graphPart.heldSymbols,
    cfg.watchedPools,
    watchAddrs,
  );

  return {
    signals: [...graphPart.signals, ...boostedX, ...fortaSignals],
    positions: graphPart.positions,
  };
}

async function maybeEnqueuePanic(
  signals: NormalizedSignal[],
  positions: PanicEvent["positions"],
) {
  const policy = await loadPolicySettings();
  const zg = policy.sources.zg
    ? await scoreSignalsWith0G(signals)
    : {
        score: 0,
        shouldPanic: false,
        severity: "low" as const,
        rationale: "0G scoring disabled in settings",
        whichSourcesMatter: [] as string[],
        provider: "0g-skipped" as const,
      };
  logger.info("0G risk score", {
    provider: zg.provider,
    score: zg.score,
    shouldPanic: zg.shouldPanic,
    severity: zg.severity,
    rationale: zg.rationale,
  });
  const event = await buildPanicEvent(signals, {
    positions,
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
      positions: event.positions.length,
    });
  } else {
    logger.info("panic suppressed (duplicate/cooldown)", {
      fingerprint: event.id,
    });
  }
}

export async function runScanner() {
  const cfg = getConfig();
  logger.info("scanner starting", {
    chainId: cfg.CHAIN_ID,
    intervalMs: cfg.SCAN_INTERVAL_MS,
    mode: cfg.EXECUTION_MODE,
    subgraph: cfg.GRAPH_UNISWAP_SUBGRAPH,
    watchedPools: cfg.watchedPools.length,
    portfolioTokens: cfg.portfolioTokens.length,
    safeWallet: cfg.SAFE_WALLET_ADDRESS || null,
    xAccounts: cfg.xWatchAccounts,
    xFixture: !cfg.X_BEARER_TOKEN,
  });

  const tick = async () => {
    try {
      await pulseBotHeartbeat("scanner").catch(() => undefined);
      const { signals, positions } = await scanOnce();
      const bySource = signals.reduce<Record<string, number>>((acc, s) => {
        acc[s.source] = (acc[s.source] ?? 0) + 1;
        return acc;
      }, {});
      if (signals.length) {
        logger.signals(
          `${signals.length} active signal(s)`,
          signals.map((s) => ({
            source: s.source,
            severity: s.severity,
            category: s.category,
            message: s.message,
          })),
        );
        const { emitActivity } = await import("@sentinel/core");
        await emitActivity({
          agent: "scanner",
          phase: "detect",
          level: "warn",
          message: `${signals.length} active signal(s)`,
          data: { bySource },
        });
        await maybeEnqueuePanic(signals, positions);
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

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runScanner().catch((err) => {
    logger.error("scanner crashed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}

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
import {
  filterSignalsByWatchlist,
  pollFortaAlerts,
  pollXExploitSignals,
  tagPortfolioMatches,
} from "@sentinel/monitors";
import { listOwnerPositions, enrichPositionAmounts } from "@sentinel/uniswap";
import { scoreSignalsWith0G } from "@sentinel/zg";
import { formatUnits } from "viem";

type WalletExposure = {
  /** Pool + token contract addresses the wallet cares about */
  addresses: string[];
  /** Token symbols held / in LP / watched */
  symbols: string[];
  /** NFT LP + watched pool rows for panic exit */
  positions: PanicEvent["positions"];
  heldSymbols: Set<string>;
};

async function loadWalletExposure(): Promise<WalletExposure> {
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

  const heldTokens = portfolio.filter((t) => BigInt(t.balanceRaw) > 0n);
  const heldSymbols = new Set(heldTokens.map((t) => t.symbol.toUpperCase()));

  const ownerPositions = await listOwnerPositions(publicClient, address).catch(
    (err: unknown) => {
      logger.warn("position list failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [] as Awaited<ReturnType<typeof listOwnerPositions>>;
    },
  );
  const enrichedPositions = await Promise.all(
    ownerPositions
      .filter((p) => p.liquidity != null && BigInt(p.liquidity) > 0n)
      .map((p) => enrichPositionAmounts(publicClient, p)),
  );
  const watchedNft = new Set(cfg.watchedPositionIds);
  const tracked =
    watchedNft.size > 0
      ? enrichedPositions.filter(
          (p) => p.nftTokenId && watchedNft.has(p.nftTokenId),
        )
      : enrichedPositions;

  const positions: PanicEvent["positions"] = tracked.map((p) => ({
    chainId: cfg.CHAIN_ID,
    pool: p.poolAddress,
    positionId: p.nftTokenId,
    tokens: [p.token0Address, p.token1Address],
  }));

  for (const poolId of cfg.watchedPools) {
    if (positions.some((pos) => pos.pool?.toLowerCase() === poolId.toLowerCase())) {
      continue;
    }
    positions.push({
      chainId: cfg.CHAIN_ID,
      pool: poolId,
      tokens: uniquePortfolio.slice(0, 2),
    });
  }

  const addressSet = new Set<string>();
  const symbolSet = new Set<string>(heldSymbols);

  for (const a of [
    ...cfg.watchedPools,
    ...heldTokens.map((t) => t.address),
    ...cfg.portfolioTokens,
    cfg.SUSD_ADDRESS,
    ...cfg.peggedTokens,
  ]) {
    if (a) addressSet.add(a.toLowerCase());
  }

  for (const pos of tracked) {
    if (pos.poolAddress) addressSet.add(pos.poolAddress.toLowerCase());
    if (pos.token0Address) addressSet.add(pos.token0Address.toLowerCase());
    if (pos.token1Address) addressSet.add(pos.token1Address.toLowerCase());
    if (pos.token0Symbol) symbolSet.add(pos.token0Symbol.toUpperCase());
    if (pos.token1Symbol) symbolSet.add(pos.token1Symbol.toUpperCase());
  }

  for (const poolId of cfg.watchedPools) {
    addressSet.add(poolId.toLowerCase());
  }

  // Include configured pegged / portfolio symbols even at zero balance so
  // threats against demo assets (sUSD) still match before the first mint.
  for (const t of portfolio) {
    symbolSet.add(t.symbol.toUpperCase());
  }
  if (cfg.SUSD_ADDRESS) symbolSet.add("SUSD");

  logger.info("wallet exposure", {
    pools: [...addressSet].filter((a) =>
      cfg.watchedPools.some((p) => p.toLowerCase() === a) ||
      tracked.some((t) => t.poolAddress?.toLowerCase() === a),
    ).length,
    tokens: heldTokens.map((t) => t.symbol),
    symbols: [...symbolSet],
    nfts: positions.map((p) => p.positionId).filter(Boolean),
  });

  return {
    addresses: [...addressSet],
    symbols: [...symbolSet],
    positions,
    heldSymbols,
  };
}

async function scanGraphPools(
  exposure: WalletExposure,
): Promise<NormalizedSignal[]> {
  const cfg = getConfig();
  const positionPools = exposure.positions
    .map((p) => p.pool)
    .filter((p): p is string => Boolean(p));
  const poolIds = [
    ...new Set(
      [...cfg.watchedPools, ...positionPools].map((p) => p.toLowerCase()),
    ),
  ];

  let pools =
    poolIds.length > 0
      ? await fetchPoolHealthByIds(poolIds)
      : await fetchPoolsForPortfolioTokens(
          exposure.addresses.filter((a) => a.startsWith("0x")),
        );

  // Attach token metadata onto watched-only position stubs when subgraph has the pool.
  for (const pos of exposure.positions) {
    if (!pos.pool || (pos.tokens?.length ?? 0) >= 2) continue;
    const health = pools.find(
      (p) => p.poolAddress.toLowerCase() === pos.pool!.toLowerCase(),
    );
    if (health) {
      pos.tokens = [health.token0.address, health.token1.address];
    }
  }

  logger.info("pool health", {
    count: pools.length,
    unhealthy: pools.filter((p) => !p.healthy).length,
    scopedTo: poolIds.length ? "wallet pools only" : "portfolio-token pools",
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

  // Graph signals already scoped to wallet pools — tag them as matches.
  return tagPortfolioMatches(poolHealthToSignals(pools), {
    addresses: exposure.addresses,
    symbols: exposure.symbols,
  });
}

function filterThreatsToWallet(
  signals: NormalizedSignal[],
  exposure: WalletExposure,
  label: string,
): NormalizedSignal[] {
  const matched = filterSignalsByWatchlist(signals, {
    addresses: exposure.addresses,
    symbols: exposure.symbols,
    keepAllIfEmpty: false,
  });
  const tagged = tagPortfolioMatches(matched, {
    addresses: exposure.addresses,
    symbols: exposure.symbols,
  });
  if (signals.length && matched.length !== signals.length) {
    logger.info(`${label} filtered to wallet exposure`, {
      before: signals.length,
      after: matched.length,
      dropped: signals.length - matched.length,
    });
  }
  if (tagged.length) {
    logger.signals(
      `${tagged.length} ${label} threat(s) matching wallet`,
      tagged.map((s) => ({
        source: s.source,
        severity: s.severity,
        category: s.category,
        message: s.message,
      })),
    );
  }
  return tagged;
}

async function scanOnce(): Promise<{
  signals: NormalizedSignal[];
  positions: PanicEvent["positions"];
}> {
  const policy = await loadPolicySettings();
  const exposure = await loadWalletExposure().catch((err) => {
    logger.error("wallet exposure failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!exposure) {
    return { signals: [], positions: [] };
  }

  const graphSignals = policy.sources.graph
    ? await scanGraphPools(exposure).catch((err) => {
        logger.error("graph scan failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as NormalizedSignal[];
      })
    : [];

  const xRaw = policy.sources.x
    ? await pollXExploitSignals().catch((err) => {
        logger.error("x scan failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as NormalizedSignal[];
      })
    : [];
  const xSignals = filterThreatsToWallet(xRaw, exposure, "x");

  const fortaRaw = policy.sources.forta ? await pollFortaAlerts() : [];
  const fortaSignals = filterThreatsToWallet(fortaRaw, exposure, "forta");

  return {
    signals: [...graphSignals, ...xSignals, ...fortaSignals],
    positions: exposure.positions,
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
          `${signals.length} wallet-matched signal(s)`,
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
          message: `${signals.length} wallet-matched signal(s)`,
          data: { bySource },
        });
        await maybeEnqueuePanic(signals, positions);
      } else {
        logger.info("no wallet-matched signals");
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

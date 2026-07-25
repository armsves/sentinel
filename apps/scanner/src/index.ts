import {
  createClients,
  getConfig,
  logger,
  type NormalizedSignal,
} from "@sentinel/core";
import {
  fetchPoolHealthByIds,
  fetchPoolsForPortfolioTokens,
  fetchPortfolioTokens,
  poolHealthToSignals,
} from "@sentinel/graph";
import { formatUnits } from "viem";

async function scanOnce(): Promise<NormalizedSignal[]> {
  const cfg = getConfig();
  const { publicClient, address } = createClients();
  if (!address) {
    throw new Error("Set WALLET_ADDRESS or PRIVATE_KEY so scanner knows the portfolio owner");
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

  const held = portfolio.filter((t) => BigInt(t.balanceRaw) > 0n).map((t) => t.address);
  const tokenUniverse = held.length ? held : portfolioAddrs;

  let pools =
    cfg.watchedPools.length > 0
      ? await fetchPoolHealthByIds(cfg.watchedPools)
      : await fetchPoolsForPortfolioTokens(tokenUniverse);

  // Always include explicitly watched pools even when also scanning by token
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

  return poolHealthToSignals(pools);
}

async function main() {
  const cfg = getConfig();
  logger.info("scanner starting", {
    chainId: cfg.CHAIN_ID,
    intervalMs: cfg.SCAN_INTERVAL_MS,
    mode: cfg.EXECUTION_MODE,
    subgraph: cfg.GRAPH_UNISWAP_SUBGRAPH,
  });

  const tick = async () => {
    try {
      const signals = await scanOnce();
      if (signals.length) {
        logger.warn("unhealthy signals", {
          count: signals.length,
          messages: signals.map((s) => s.message),
        });
      } else {
        logger.info("all watched pools healthy");
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

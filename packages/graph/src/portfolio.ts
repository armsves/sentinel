import { getEffectiveConfig, type NormalizedSignal, type PoolHealth, type PortfolioToken } from "@sentinel/core";
import { erc20Abi, formatUnits, type PublicClient, type Chain, type Transport } from "viem";
import { graphQuery } from "./client.js";

const TOKEN_META_QUERY = /* GraphQL */ `
  query Tokens($ids: [ID!]!) {
    tokens(where: { id_in: $ids }) {
      id
      symbol
      name
      decimals
      derivedETH
      volumeUSD
      totalValueLockedUSD
    }
  }
`;

const POOLS_BY_ID_QUERY = /* GraphQL */ `
  query Pools($ids: [ID!]!) {
    pools(where: { id_in: $ids }) {
      id
      feeTier
      liquidity
      totalValueLockedUSD
      volumeUSD
      token0Price
      token1Price
      token0 { id symbol }
      token1 { id symbol }
      poolDayData(first: 2, orderBy: date, orderDirection: desc) {
        date
        volumeUSD
        tvlUSD
        token0Price
        token1Price
      }
    }
  }
`;

const POOLS_TOKEN0_QUERY = /* GraphQL */ `
  query PoolsToken0($tokens: [String!]!, $minTvl: BigDecimal!) {
    pools(
      first: 25
      orderBy: totalValueLockedUSD
      orderDirection: desc
      where: { token0_in: $tokens, totalValueLockedUSD_gt: $minTvl }
    ) {
      id
      feeTier
      liquidity
      totalValueLockedUSD
      volumeUSD
      token0Price
      token1Price
      token0 { id symbol }
      token1 { id symbol }
      poolDayData(first: 2, orderBy: date, orderDirection: desc) {
        date
        volumeUSD
        tvlUSD
        token0Price
        token1Price
      }
    }
  }
`;

const POOLS_TOKEN1_QUERY = /* GraphQL */ `
  query PoolsToken1($tokens: [String!]!, $minTvl: BigDecimal!) {
    pools(
      first: 25
      orderBy: totalValueLockedUSD
      orderDirection: desc
      where: { token1_in: $tokens, totalValueLockedUSD_gt: $minTvl }
    ) {
      id
      feeTier
      liquidity
      totalValueLockedUSD
      volumeUSD
      token0Price
      token1Price
      token0 { id symbol }
      token1 { id symbol }
      poolDayData(first: 2, orderBy: date, orderDirection: desc) {
        date
        volumeUSD
        tvlUSD
        token0Price
        token1Price
      }
    }
  }
`;

type GToken = {
  id: string;
  symbol: string;
  name: string;
  decimals: string;
  derivedETH?: string;
  volumeUSD?: string;
  totalValueLockedUSD?: string;
};

type GPool = {
  id: string;
  feeTier?: string;
  liquidity: string;
  totalValueLockedUSD: string;
  volumeUSD?: string;
  token0Price?: string;
  token1Price?: string;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
  poolDayData?: Array<{
    date: number;
    volumeUSD: string;
    tvlUSD: string;
    token0Price?: string;
    token1Price?: string;
  }>;
};

const PEG_SYMBOL_RE = /^(s?usd|usdc|usdt|dai|eurc|usde|susde|frax|lusd|gusd|crvusd|scrvusd)$/i;

function peggedTokenSet(cfg: Awaited<ReturnType<typeof getEffectiveConfig>>): Set<string> {
  const addrs = [
    cfg.USDC_ADDRESS,
    cfg.USDT_ADDRESS,
    cfg.DAI_ADDRESS,
    cfg.SUSD_ADDRESS,
    ...cfg.peggedTokens,
  ]
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[a-f0-9]{40}$/.test(a));
  return new Set(addrs);
}

function isPegCandidate(
  token: { id: string; symbol: string },
  pegged: Set<string>,
): boolean {
  return pegged.has(token.id.toLowerCase()) || PEG_SYMBOL_RE.test(token.symbol);
}

async function assessPool(pool: GPool): Promise<PoolHealth> {
  const cfg = await getEffectiveConfig();
  const tvlUsd = Number(pool.totalValueLockedUSD || 0);
  const issues: string[] = [];
  const day = pool.poolDayData ?? [];
  const volumeUsd24h = day[0] ? Number(day[0].volumeUSD) : undefined;

  if (tvlUsd < cfg.POOL_MIN_TVL_USD) {
    issues.push(`TVL $${tvlUsd.toFixed(0)} below min $${cfg.POOL_MIN_TVL_USD}`);
  }
  if (day.length >= 2) {
    const tvlNow = Number(day[0]?.tvlUSD ?? tvlUsd);
    const tvlPrev = Number(day[1]?.tvlUSD ?? tvlNow);
    if (tvlPrev > 0) {
      const dropPct = ((tvlPrev - tvlNow) / tvlPrev) * 100;
      if (dropPct >= cfg.POOL_TVL_DROP_THRESHOLD_PCT) {
        issues.push(`TVL dropped ${dropPct.toFixed(1)}% vs prior day`);
      }
    }

    // Stop-loss: day-over-day token price drop in the pool
    for (const side of ["token0", "token1"] as const) {
      const priceKey = side === "token0" ? "token0Price" : "token1Price";
      const now = Number(day[0]?.[priceKey] ?? pool[priceKey] ?? 0);
      const prev = Number(day[1]?.[priceKey] ?? now);
      if (prev > 0 && now > 0) {
        const dropPct = ((prev - now) / prev) * 100;
        if (dropPct >= cfg.PRICE_DROP_THRESHOLD_PCT) {
          const sym = side === "token0" ? pool.token0.symbol : pool.token1.symbol;
          issues.push(
            `${sym} price dropped ${dropPct.toFixed(1)}% vs prior day (stop-loss)`,
          );
        }
      }
    }
  }
  if (BigInt(pool.liquidity || "0") === 0n) {
    issues.push("zero liquidity");
  }

  // Peg / depeg: known stables + sUSD / other pegged assets
  const pegged = peggedTokenSet(cfg);
  const t0Peg = isPegCandidate(pool.token0, pegged);
  const t1Peg = isPegCandidate(pool.token1, pegged);
  if (t0Peg && t1Peg) {
    const p = Number(pool.token0Price ?? 1);
    const deviationBps = Math.abs(p - 1) * 10_000;
    if (deviationBps >= cfg.DEPEG_THRESHOLD_BPS) {
      issues.push(
        `depeg ${pool.token0.symbol}/${pool.token1.symbol} ${deviationBps.toFixed(0)} bps`,
      );
    }
  } else if (t0Peg !== t1Peg) {
    // Volatile vs stable: only flag 1:1 depeg when the non-reserve side looks pegged
    // (e.g. sUSD/USDC). tokenXPrice ≈ units of other token per this token.
    const pegPrice = t0Peg
      ? Number(pool.token0Price ?? 0)
      : Number(pool.token1Price ?? 0);
    if (pegPrice > 0) {
      // If price is within a wide band of 1, treat as intended peg and measure deviation.
      // Skip pure volatile pairs (WETH/USDC) where pegPrice is nowhere near 1.
      if (pegPrice > 0.5 && pegPrice < 2) {
        const deviationBps = Math.abs(pegPrice - 1) * 10_000;
        if (deviationBps >= cfg.DEPEG_THRESHOLD_BPS) {
          const soft = t0Peg ? pool.token0.symbol : pool.token1.symbol;
          issues.push(`depeg ${soft} ${deviationBps.toFixed(0)} bps vs stable`);
        }
      }
    }
  }

  return {
    poolAddress: pool.id,
    token0: { address: pool.token0.id, symbol: pool.token0.symbol },
    token1: { address: pool.token1.id, symbol: pool.token1.symbol },
    feeTier: pool.feeTier ? Number(pool.feeTier) : undefined,
    tvlUsd,
    volumeUsd24h,
    liquidity: pool.liquidity,
    token0Price: pool.token0Price ? Number(pool.token0Price) : undefined,
    token1Price: pool.token1Price ? Number(pool.token1Price) : undefined,
    healthy: issues.length === 0,
    issues,
    ts: Date.now(),
  };
}

export async function fetchTokenMeta(ids: string[]): Promise<GToken[]> {
  if (!ids.length) return [];
  const normalized = ids.map((id) => id.toLowerCase());
  const data = await graphQuery<{ tokens: GToken[] }>(TOKEN_META_QUERY, {
    ids: normalized,
  });
  return data.tokens;
}

export async function fetchPortfolioTokens(opts: {
  publicClient: PublicClient<Transport, Chain>;
  owner: `0x${string}`;
  tokenAddresses: `0x${string}`[];
}): Promise<PortfolioToken[]> {
  const unique = [...new Set(opts.tokenAddresses.map((t) => t.toLowerCase()))] as `0x${string}`[];
  const meta = await fetchTokenMeta(unique);
  const metaById = new Map(meta.map((t) => [t.id.toLowerCase(), t]));

  const out: PortfolioToken[] = [];
  for (const address of unique) {
    const raw = await opts.publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [opts.owner],
    });
    const m = metaById.get(address.toLowerCase());
    const decimals = m ? Number(m.decimals) : 18;
    const symbol = m?.symbol ?? "UNKNOWN";
    const name = m?.name ?? symbol;
    out.push({
      address,
      symbol,
      name,
      decimals,
      balanceRaw: raw.toString(),
      derivedEth: m?.derivedETH ? Number(m.derivedETH) : undefined,
    });
    // human-readable for logs
    void formatUnits(raw, decimals);
  }
  return out;
}

export async function fetchPoolHealthByIds(poolIds: string[]): Promise<PoolHealth[]> {
  if (!poolIds.length) return [];
  const data = await graphQuery<{ pools: GPool[] }>(POOLS_BY_ID_QUERY, {
    ids: poolIds.map((p) => p.toLowerCase()),
  });
  return Promise.all(data.pools.map((p) => assessPool(p)));
}

export async function fetchPoolsForPortfolioTokens(
  tokenAddresses: string[],
): Promise<PoolHealth[]> {
  if (!tokenAddresses.length) return [];
  const cfg = await getEffectiveConfig();
  const tokens = tokenAddresses.map((t) => t.toLowerCase());
  const minTvl = String(Math.max(1, cfg.POOL_MIN_TVL_USD / 10));
  const [a, b] = await Promise.all([
    graphQuery<{ pools: GPool[] }>(POOLS_TOKEN0_QUERY, { tokens, minTvl }),
    graphQuery<{ pools: GPool[] }>(POOLS_TOKEN1_QUERY, { tokens, minTvl }),
  ]);
  const byId = new Map<string, GPool>();
  for (const p of [...a.pools, ...b.pools]) byId.set(p.id, p);
  return Promise.all([...byId.values()].map((p) => assessPool(p)));
}

export function poolHealthToSignals(pools: PoolHealth[]): NormalizedSignal[] {
  return pools
    .filter((p) => !p.healthy)
    .map((p) => {
      const hasDepeg = p.issues.some((i) => i.toLowerCase().includes("depeg"));
      const hasStopLoss = p.issues.some((i) =>
        i.toLowerCase().includes("stop-loss"),
      );
      const hasDrain = p.issues.some(
        (i) =>
          i.toLowerCase().includes("dropped") ||
          i.toLowerCase().includes("zero liquidity"),
      );
      const category = hasDepeg
        ? ("depeg" as const)
        : hasStopLoss
          ? ("price" as const)
          : ("pool_health" as const);
      const severity =
        hasDepeg || hasStopLoss || hasDrain
          ? ("high" as const)
          : ("medium" as const);
      return {
        source: "graph" as const,
        severity,
        addresses: [p.poolAddress, p.token0.address, p.token1.address],
        tokens: [p.token0.symbol, p.token1.symbol],
        category,
        message: `Pool ${p.token0.symbol}/${p.token1.symbol} unhealthy: ${p.issues.join("; ")}`,
        raw: p,
        ts: p.ts,
      };
    });
}

import {
  getConfig,
  type NormalizedSignal,
  type PoolHealth,
  type PortfolioToken,
} from "@sentinel/core";
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
  poolDayData?: Array<{ date: number; volumeUSD: string; tvlUSD: string }>;
};

function assessPool(pool: GPool): PoolHealth {
  const cfg = getConfig();
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
  }
  if (BigInt(pool.liquidity || "0") === 0n) {
    issues.push("zero liquidity");
  }

  // crude stable depeg check when one side is a known stable
  const stables = new Set(
    [cfg.USDC_ADDRESS, cfg.USDT_ADDRESS, cfg.DAI_ADDRESS].map((a) => a.toLowerCase()),
  );
  const t0Stable = stables.has(pool.token0.id.toLowerCase());
  const t1Stable = stables.has(pool.token1.id.toLowerCase());
  if (t0Stable !== t1Stable) {
    const price = t0Stable
      ? Number(pool.token1Price ?? 0)
      : Number(pool.token0Price ?? 0);
    // price of volatile in stable terms — skip; for stable-stable check:
  }
  if (t0Stable && t1Stable) {
    const p = Number(pool.token0Price ?? 1);
    const deviationBps = Math.abs(p - 1) * 10_000;
    if (deviationBps >= cfg.DEPEG_THRESHOLD_BPS) {
      issues.push(`stable-stable peg deviation ${deviationBps.toFixed(0)} bps`);
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
  return data.pools.map(assessPool);
}

export async function fetchPoolsForPortfolioTokens(
  tokenAddresses: string[],
): Promise<PoolHealth[]> {
  if (!tokenAddresses.length) return [];
  const cfg = getConfig();
  const tokens = tokenAddresses.map((t) => t.toLowerCase());
  const minTvl = String(Math.max(1000, cfg.POOL_MIN_TVL_USD / 10));
  const [a, b] = await Promise.all([
    graphQuery<{ pools: GPool[] }>(POOLS_TOKEN0_QUERY, { tokens, minTvl }),
    graphQuery<{ pools: GPool[] }>(POOLS_TOKEN1_QUERY, { tokens, minTvl }),
  ]);
  const byId = new Map<string, GPool>();
  for (const p of [...a.pools, ...b.pools]) byId.set(p.id, p);
  return [...byId.values()].map(assessPool);
}

export function poolHealthToSignals(pools: PoolHealth[]): NormalizedSignal[] {
  return pools
    .filter((p) => !p.healthy)
    .map((p) => ({
      source: "graph" as const,
      severity: p.issues.some((i) => i.includes("dropped") || i.includes("depeg"))
        ? ("high" as const)
        : ("medium" as const),
      addresses: [p.poolAddress, p.token0.address, p.token1.address],
      tokens: [p.token0.symbol, p.token1.symbol],
      category: p.issues.some((i) => i.includes("peg"))
        ? ("depeg" as const)
        : ("pool_health" as const),
      message: `Pool ${p.token0.symbol}/${p.token1.symbol} unhealthy: ${p.issues.join("; ")}`,
      raw: p,
      ts: p.ts,
    }));
}

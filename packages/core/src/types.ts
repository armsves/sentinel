export type Severity = "low" | "medium" | "high" | "critical";

export type SignalSource =
  | "glider"
  | "graph"
  | "forta"
  | "defimon"
  | "price"
  | "zg"
  | "uniswap";

export type SignalCategory =
  | "exploit"
  | "hack"
  | "depeg"
  | "price"
  | "dependency"
  | "invariant"
  | "pool_health"
  | "other";

export type NormalizedSignal = {
  source: SignalSource;
  severity: Severity;
  addresses: string[];
  tokens?: string[];
  category: SignalCategory;
  message: string;
  raw: unknown;
  ts: number;
};

export type PanicEvent = {
  id: string;
  ts: number;
  severity: Severity;
  reasons: Array<{
    source: SignalSource;
    signal: string;
    evidence: Record<string, unknown>;
  }>;
  positions: Array<{
    chainId: number;
    pool?: string;
    positionId?: string;
    tokens: string[];
  }>;
  targetStables: Array<"USDC" | "USDT" | "DAI">;
  mode: "dry_run" | "live";
  zgScore?: number;
  zgRationale?: string;
};

export type PortfolioToken = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balanceRaw: string;
  balanceUsd?: number;
  derivedEth?: number;
};

export type PoolHealth = {
  poolAddress: string;
  token0: { address: string; symbol: string };
  token1: { address: string; symbol: string };
  feeTier?: number;
  tvlUsd: number;
  volumeUsd24h?: number;
  liquidity: string;
  token0Price?: number;
  token1Price?: number;
  healthy: boolean;
  issues: string[];
  ts: number;
};

export type PositionSummary = {
  protocol: "V2" | "V3" | "V4";
  nftTokenId?: string;
  poolAddress?: string;
  token0Address: string;
  token1Address: string;
  token0Symbol?: string;
  token1Symbol?: string;
  liquidity?: string;
  tickLower?: number;
  tickUpper?: number;
  feeTier?: number;
};

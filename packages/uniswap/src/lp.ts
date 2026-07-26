import { getConfig, logger, type PositionSummary } from "@sentinel/core";
import {
  erc20Abi,
  formatUnits,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { apiPost, lpHeaders, sendApiTx, type ApiTx } from "./http.js";
import { getAmountsForPosition } from "./v3math.js";

export type Protocol = "V2" | "V3" | "V4";

type ApprovalAction = "CREATE" | "INCREASE" | "DECREASE" | "MIGRATE";

type LpApprovalResponse = {
  transactions?: Array<{ transaction: ApiTx }>;
  v4BatchPermitData?: unknown;
  v3NftPermitData?: unknown;
  kycRequiredWarnings?: unknown[];
};

export async function checkLpApproval(params: {
  walletAddress: `0x${string}`;
  protocol: Protocol;
  chainId: number;
  lpTokens: Array<{ tokenAddress: string; amount: string }>;
  action: ApprovalAction;
  v3NftTokenId?: number;
}): Promise<LpApprovalResponse> {
  const cfg = getConfig();
  return apiPost<LpApprovalResponse>(
    `${cfg.UNISWAP_LP_API_BASE_URL}/lp/check_approval`,
    params,
    lpHeaders(),
  );
}

async function runApprovals(opts: {
  approval: LpApprovalResponse;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient<Transport, Chain>;
  dryRun: boolean;
}) {
  if (opts.approval.kycRequiredWarnings?.length) {
    throw new Error("Wallet not allowlisted for permissioned pool (KYC required)");
  }
  for (const item of opts.approval.transactions ?? []) {
    await sendApiTx({
      tx: item.transaction,
      walletClient: opts.walletClient,
      publicClient: opts.publicClient,
      dryRun: opts.dryRun,
      label: "lp_approval",
    });
  }
}

export type CreatePositionParams = {
  walletAddress: `0x${string}`;
  protocol: Protocol;
  chainId: number;
  token0Address: `0x${string}`;
  token1Address: `0x${string}`;
  poolReference: string;
  independentToken: { tokenAddress: `0x${string}`; amount: string };
  /** Human-readable decimal prices (token1 per token0) or tick bounds */
  priceBounds?: { minPrice: string; maxPrice: string };
  tickBounds?: { tickLower: number; tickUpper: number };
  simulateTransaction?: boolean;
};

export async function createPosition(opts: {
  params: CreatePositionParams;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient<Transport, Chain>;
  dryRun: boolean;
}): Promise<{ response: unknown; hash?: Hex; simulated: boolean }> {
  const p = opts.params;
  const approval = await checkLpApproval({
    walletAddress: p.walletAddress,
    protocol: p.protocol,
    chainId: p.chainId,
    action: "CREATE",
    lpTokens: [
      { tokenAddress: p.token0Address, amount: p.independentToken.amount },
      { tokenAddress: p.token1Address, amount: p.independentToken.amount },
    ],
  });
  await runApprovals({ ...opts, approval });

  const body: Record<string, unknown> = {
    walletAddress: p.walletAddress,
    protocol: p.protocol,
    chainId: p.chainId,
    existingPool: {
      token0Address: p.token0Address,
      token1Address: p.token1Address,
      poolReference: p.poolReference,
    },
    independentToken: p.independentToken,
    simulateTransaction: p.simulateTransaction ?? opts.dryRun,
  };
  if (p.priceBounds) body.priceBounds = p.priceBounds;
  if (p.tickBounds) body.tickBounds = p.tickBounds;

  const cfg = getConfig();
  const response = await apiPost<{ create: ApiTx; requestId?: string }>(
    `${cfg.UNISWAP_LP_API_BASE_URL}/lp/create`,
    body,
    lpHeaders(),
  );
  logger.info("lp create planned", { requestId: response.requestId });
  const result = await sendApiTx({
    tx: response.create,
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    dryRun: opts.dryRun,
    label: "lp_create",
  });
  return { response, ...result };
}

export type DecreasePositionParams = {
  walletAddress: `0x${string}`;
  protocol: Protocol;
  chainId: number;
  token0Address: `0x${string}`;
  token1Address: `0x${string}`;
  nftTokenId: string;
  liquidityPercentageToDecrease: number;
  simulateTransaction?: boolean;
};

export async function decreasePosition(opts: {
  params: DecreasePositionParams;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient<Transport, Chain>;
  dryRun: boolean;
}): Promise<{ response: unknown; hash?: Hex; simulated: boolean }> {
  const p = opts.params;
  const pct = Math.min(100, Math.max(1, Math.floor(p.liquidityPercentageToDecrease)));

  const approval = await checkLpApproval({
    walletAddress: p.walletAddress,
    protocol: p.protocol,
    chainId: p.chainId,
    action: "DECREASE",
    lpTokens: [],
    v3NftTokenId: Number(p.nftTokenId),
  });
  await runApprovals({ ...opts, approval });

  const cfg = getConfig();
  const response = await apiPost<{ decrease: ApiTx; requestId?: string }>(
    `${cfg.UNISWAP_LP_API_BASE_URL}/lp/decrease`,
    {
      walletAddress: p.walletAddress,
      protocol: p.protocol,
      chainId: p.chainId,
      token0Address: p.token0Address,
      token1Address: p.token1Address,
      nftTokenId: p.nftTokenId,
      liquidityPercentageToDecrease: pct,
      simulateTransaction: p.simulateTransaction ?? opts.dryRun,
    },
    lpHeaders(),
  );
  logger.info("lp decrease planned", { requestId: response.requestId, pct });
  const result = await sendApiTx({
    tx: response.decrease,
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    dryRun: opts.dryRun,
    label: "lp_decrease",
  });
  return { response, ...result };
}

export async function getPoolInfo(params: {
  protocol: Protocol;
  chainId: number;
  poolReference?: string;
  tokenAddressA?: `0x${string}`;
  tokenAddressB?: `0x${string}`;
  fee?: number;
}): Promise<unknown> {
  const cfg = getConfig();
  const body: Record<string, unknown> = {
    protocol: params.protocol,
    chainId: params.chainId,
  };
  if (params.poolReference) {
    body.poolReferences = [params.poolReference];
  } else if (params.tokenAddressA && params.tokenAddressB) {
    body.poolParameters = {
      tokenAddressA: params.tokenAddressA,
      tokenAddressB: params.tokenAddressB,
      ...(params.fee !== undefined ? { fee: params.fee } : {}),
    };
  }
  return apiPost(
    `${cfg.UNISWAP_LP_API_BASE_URL}/lp/pool_info`,
    body,
    lpHeaders(),
  );
}

/** Read v3 NFT position manager positions via RPC (check position). */
const NPM_ABI = [
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenOfOwnerByIndex",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Mainnet NonfungiblePositionManager */
export const V3_NPM: Record<number, `0x${string}`> = {
  1: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  10: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  42161: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  8453: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  137: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  /** Uniswap v3 NonfungiblePositionManager on Ethereum Sepolia */
  11155111: "0x1238536071E1c677A632429e3655c799b22cDA52",
};

export const V3_FACTORY: Record<number, `0x${string}`> = {
  1: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  10: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  42161: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  8453: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  137: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  11155111: "0x0227628f3F457C4401c86Fc05597ce00c2F1aF4f",
};

const V3_FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

export async function getPositionByTokenId(
  publicClient: PublicClient<Transport, Chain>,
  tokenId: bigint,
  chainId = getConfig().CHAIN_ID,
): Promise<PositionSummary> {
  const npm = V3_NPM[chainId];
  if (!npm) throw new Error(`No V3 NPM for chain ${chainId}`);
  const pos = await publicClient.readContract({
    address: npm,
    abi: NPM_ABI,
    functionName: "positions",
    args: [tokenId],
  });
  return {
    protocol: "V3",
    nftTokenId: tokenId.toString(),
    token0Address: pos[2],
    token1Address: pos[3],
    feeTier: Number(pos[4]),
    tickLower: Number(pos[5]),
    tickUpper: Number(pos[6]),
    liquidity: pos[7].toString(),
    tokensOwed0: pos[10].toString(),
    tokensOwed1: pos[11].toString(),
  };
}

export async function listOwnerPositions(
  publicClient: PublicClient<Transport, Chain>,
  owner: `0x${string}`,
  chainId = getConfig().CHAIN_ID,
  max = 25,
): Promise<PositionSummary[]> {
  const npm = V3_NPM[chainId];
  if (!npm) throw new Error(`No V3 NPM for chain ${chainId}`);
  const balance = await publicClient.readContract({
    address: npm,
    abi: NPM_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
  const count = Number(balance > BigInt(max) ? BigInt(max) : balance);
  const out: PositionSummary[] = [];
  for (let i = 0; i < count; i++) {
    const tokenId = await publicClient.readContract({
      address: npm,
      abi: NPM_ABI,
      functionName: "tokenOfOwnerByIndex",
      args: [owner, BigInt(i)],
    });
    out.push(await getPositionByTokenId(publicClient, tokenId, chainId));
  }
  return out;
}

const V3_POOL_ABI = [
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "fee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint24" }],
  },
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

export type V3PoolKey = {
  pool: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
};

export async function readV3PoolKey(
  publicClient: PublicClient<Transport, Chain>,
  poolAddress: `0x${string}`,
): Promise<V3PoolKey> {
  const [token0, token1, fee] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: V3_POOL_ABI,
      functionName: "token0",
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: V3_POOL_ABI,
      functionName: "token1",
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: V3_POOL_ABI,
      functionName: "fee",
    }),
  ]);
  return {
    pool: poolAddress.toLowerCase() as `0x${string}`,
    token0: token0.toLowerCase() as `0x${string}`,
    token1: token1.toLowerCase() as `0x${string}`,
    fee: Number(fee),
  };
}

export function positionMatchesPool(
  pos: PositionSummary,
  key: V3PoolKey,
): boolean {
  const t0 = pos.token0Address.toLowerCase();
  const t1 = pos.token1Address.toLowerCase();
  if (t0 !== key.token0 || t1 !== key.token1) return false;
  if (pos.feeTier != null && pos.feeTier !== key.fee) return false;
  return true;
}

/** Attach current token amounts + symbols for a v3 NFT position. */
export async function enrichPositionAmounts(
  publicClient: PublicClient<Transport, Chain>,
  pos: PositionSummary,
  chainId = getConfig().CHAIN_ID,
): Promise<PositionSummary> {
  if (
    pos.protocol !== "V3" ||
    pos.liquidity == null ||
    pos.tickLower == null ||
    pos.tickUpper == null
  ) {
    return pos;
  }

  let pool = pos.poolAddress?.toLowerCase() as `0x${string}` | undefined;
  if (!pool && pos.feeTier != null) {
    const factory = V3_FACTORY[chainId];
    if (factory) {
      try {
        const resolved = await publicClient.readContract({
          address: factory,
          abi: V3_FACTORY_ABI,
          functionName: "getPool",
          args: [
            pos.token0Address as `0x${string}`,
            pos.token1Address as `0x${string}`,
            pos.feeTier,
          ],
        });
        if (resolved && resolved !== "0x0000000000000000000000000000000000000000") {
          pool = resolved.toLowerCase() as `0x${string}`;
        }
      } catch {
        /* leave unresolved */
      }
    }
  }
  if (!pool) return pos;

  try {
    const [slot0, dec0, dec1, sym0, sym1] = await Promise.all([
      publicClient.readContract({
        address: pool,
        abi: V3_POOL_ABI,
        functionName: "slot0",
      }),
      publicClient.readContract({
        address: pos.token0Address as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      publicClient.readContract({
        address: pos.token1Address as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      publicClient.readContract({
        address: pos.token0Address as `0x${string}`,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      publicClient.readContract({
        address: pos.token1Address as `0x${string}`,
        abi: erc20Abi,
        functionName: "symbol",
      }),
    ]);

    const sqrtPriceX96 = slot0[0] as bigint;
    const currentTick = Number(slot0[1]);
    const { amount0, amount1 } = getAmountsForPosition({
      sqrtPriceX96,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      liquidity: BigInt(pos.liquidity),
    });
    const d0 = Number(dec0);
    const d1 = Number(dec1);

    return {
      ...pos,
      poolAddress: pool,
      token0Symbol: String(sym0),
      token1Symbol: String(sym1),
      token0Decimals: d0,
      token1Decimals: d1,
      amount0Raw: amount0.toString(),
      amount1Raw: amount1.toString(),
      amount0: formatUnits(amount0, d0),
      amount1: formatUnits(amount1, d1),
      currentTick,
      inRange: currentTick >= pos.tickLower && currentTick < pos.tickUpper,
    };
  } catch (err) {
    logger.warn("failed to enrich position amounts", {
      nft: pos.nftTokenId,
      pool,
      error: err instanceof Error ? err.message : String(err),
    });
    return pos;
  }
}

/** Split owner NFTs into watched-pool positions vs everything else. */
export async function partitionOwnerPositions(
  publicClient: PublicClient<Transport, Chain>,
  owner: `0x${string}`,
  watchedPools: string[],
): Promise<{
  watched: PositionSummary[];
  other: PositionSummary[];
  poolKeys: V3PoolKey[];
}> {
  const all = (await listOwnerPositions(publicClient, owner)).filter(
    (p) => p.liquidity != null && BigInt(p.liquidity) > 0n,
  );
  if (!watchedPools.length) {
    const enriched = await Promise.all(
      all.map((p) => enrichPositionAmounts(publicClient, p)),
    );
    return { watched: [], other: enriched, poolKeys: [] };
  }

  const poolKeys: V3PoolKey[] = [];
  for (const pool of watchedPools) {
    try {
      poolKeys.push(
        await readV3PoolKey(publicClient, pool.toLowerCase() as `0x${string}`),
      );
    } catch (err) {
      logger.warn("failed to read watched pool", {
        pool,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const watched: PositionSummary[] = [];
  const other: PositionSummary[] = [];
  for (const pos of all) {
    const match = poolKeys.find((k) => positionMatchesPool(pos, k));
    if (match) {
      watched.push({ ...pos, poolAddress: match.pool });
    } else {
      other.push(pos);
    }
  }

  const [watchedEnriched, otherEnriched] = await Promise.all([
    Promise.all(watched.map((p) => enrichPositionAmounts(publicClient, p))),
    Promise.all(other.map((p) => enrichPositionAmounts(publicClient, p))),
  ]);

  return { watched: watchedEnriched, other: otherEnriched, poolKeys };
}

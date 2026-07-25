import { getConfig, logger, type PositionSummary } from "@sentinel/core";
import type { Account, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import { apiPost, lpHeaders, sendApiTx, type ApiTx } from "./http.js";

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
};

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

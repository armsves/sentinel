import { getConfig, logger } from "@sentinel/core";
import type { Account, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import {
  apiPost,
  sendApiTx,
  stripNulls,
  tradeHeaders,
  type ApiTx,
} from "./http.js";

export type SwapParams = {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amount: string;
  swapper: `0x${string}`;
  type?: "EXACT_INPUT" | "EXACT_OUTPUT";
  slippageTolerance?: number;
  routingPreference?: "BEST_PRICE" | "FASTEST";
};

type QuoteResponse = {
  routing: string;
  quote: Record<string, unknown>;
  permitData?: unknown;
  permitTransaction?: ApiTx | null;
  requestId?: string;
};

type SwapResponse = {
  swap?: ApiTx;
  requestId?: string;
};

type ApprovalResponse = {
  approval?: ApiTx | null;
  cancel?: ApiTx | null;
};

export async function checkSwapApproval(params: {
  walletAddress: `0x${string}`;
  token: `0x${string}`;
  amount: string;
  chainId: number;
}): Promise<ApiTx | null> {
  const cfg = getConfig();
  const data = await apiPost<ApprovalResponse>(
    `${cfg.UNISWAP_TRADE_API_BASE_URL}/check_approval`,
    {
      walletAddress: params.walletAddress,
      token: params.token,
      amount: params.amount,
      chainId: params.chainId,
    },
    tradeHeaders(),
  );
  return data.approval ?? null;
}

export async function getQuote(params: SwapParams): Promise<QuoteResponse> {
  const cfg = getConfig();
  const chainId = String(cfg.CHAIN_ID);
  return apiPost<QuoteResponse>(
    `${cfg.UNISWAP_TRADE_API_BASE_URL}/quote`,
    {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      amount: params.amount,
      type: params.type ?? "EXACT_INPUT",
      swapper: params.swapper,
      slippageTolerance: params.slippageTolerance ?? cfg.SLIPPAGE_TOLERANCE,
      routingPreference: params.routingPreference ?? "BEST_PRICE",
      protocols: ["V3"],
    },
    tradeHeaders(),
  );
}

export async function buildSwapTx(
  quote: QuoteResponse,
  permit2Signature?: string,
): Promise<ApiTx> {
  const cfg = getConfig();
  const { permitData, permitTransaction, ...clean } = quote;
  const body: Record<string, unknown> = { ...stripNulls(clean as Record<string, unknown>) };

  const isUniswapX =
    quote.routing === "DUTCH_V2" ||
    quote.routing === "DUTCH_V3" ||
    quote.routing === "PRIORITY";

  if (isUniswapX) {
    if (permit2Signature) body.signature = permit2Signature;
  } else if (permit2Signature && permitData && typeof permitData === "object") {
    body.signature = permit2Signature;
    body.permitData = permitData;
  }

  const data = await apiPost<SwapResponse>(
    `${cfg.UNISWAP_TRADE_API_BASE_URL}/swap`,
    body,
    tradeHeaders(),
  );
  if (!data.swap) throw new Error("swap response missing swap tx");
  return data.swap;
}

async function maybeSignPermit(
  quote: QuoteResponse,
  walletClient: WalletClient<Transport, Chain, Account>,
): Promise<string | undefined> {
  const permit = quote.permitData as
    | {
        domain: Record<string, unknown>;
        types: Record<string, Array<{ name: string; type: string }>>;
        values: Record<string, unknown>;
      }
    | null
    | undefined;
  if (!permit || typeof permit !== "object") return undefined;

  const types = Object.fromEntries(
    Object.entries(permit.types).map(([k, v]) => {
      const fields = Array.isArray(v) ? v : (v as { fields?: unknown })?.fields;
      return [k, fields];
    }),
  ) as Record<string, Array<{ name: string; type: string }>>;

  const primaryType =
    Object.keys(types).find((k) => k !== "EIP712Domain") ?? "PermitSingle";

  // Permit payloads vary by route; cast for dynamic EIP-712 shapes from the API.
  return (walletClient as any).signTypedData({
    account: walletClient.account!,
    domain: permit.domain,
    types,
    primaryType,
    message: permit.values,
  });
}

export async function executeSwap(opts: {
  params: SwapParams;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient<Transport, Chain>;
  dryRun: boolean;
  /** Skip /check_approval when Permit2 allowances are already set. */
  skipApproval?: boolean;
}): Promise<{ quote: QuoteResponse; hash?: Hex; simulated: boolean }> {
  const cfg = getConfig();
  if (!opts.skipApproval) {
    const approval = await checkSwapApproval({
      walletAddress: opts.params.swapper,
      token: opts.params.tokenIn,
      amount: opts.params.amount,
      chainId: cfg.CHAIN_ID,
    });

    if (approval) {
      await sendApiTx({
        tx: approval,
        walletClient: opts.walletClient,
        publicClient: opts.publicClient,
        dryRun: opts.dryRun,
        label: "swap_approval",
      });
    }
  }

  const quote = await getQuote(opts.params);
  logger.info("got swap quote", {
    routing: quote.routing,
    requestId: quote.requestId,
  });

  let signature: string | undefined;
  if (!opts.dryRun) {
    signature = await maybeSignPermit(quote, opts.walletClient);
  }

  const swapTx = await buildSwapTx(quote, signature);
  const result = await sendApiTx({
    tx: swapTx,
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    dryRun: opts.dryRun,
    label: "swap",
  });

  return { quote, ...result };
}

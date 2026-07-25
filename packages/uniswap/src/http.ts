import { getConfig, logger } from "@sentinel/core";
import {
  isAddress,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

export type ApiTx = {
  to: string;
  from?: string;
  data: string;
  value?: string;
  chainId?: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
};

export function tradeHeaders(): Record<string, string> {
  const cfg = getConfig();
  if (!cfg.UNISWAP_API_KEY) {
    throw new Error("UNISWAP_API_KEY is required for Trading API calls");
  }
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-key": cfg.UNISWAP_API_KEY,
    "x-universal-router-version": "2.0",
  };
}

export function lpHeaders(): Record<string, string> {
  const cfg = getConfig();
  if (!cfg.UNISWAP_API_KEY) {
    throw new Error("UNISWAP_API_KEY is required for LP API calls");
  }
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-key": cfg.UNISWAP_API_KEY,
  };
}

export async function apiPost<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `Uniswap API ${res.status} ${url}: ${typeof json === "object" ? JSON.stringify(json) : text}`,
    );
  }
  return json as T;
}

export function validateTx(tx: ApiTx, label = "tx"): void {
  if (!tx?.data || tx.data === "" || tx.data === "0x") {
    throw new Error(`${label}.data is empty — quote/plan may have expired`);
  }
  if (!isAddress(tx.to)) {
    throw new Error(`${label}.to is not a valid address`);
  }
}

export async function sendApiTx(opts: {
  tx: ApiTx;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient<Transport, Chain>;
  dryRun: boolean;
  label: string;
}): Promise<{ hash?: Hex; simulated: boolean }> {
  validateTx(opts.tx, opts.label);
  if (opts.dryRun) {
    logger.info(`[dry_run] would send ${opts.label}`, {
      to: opts.tx.to,
      value: opts.tx.value ?? "0",
      dataLen: opts.tx.data.length,
    });
    return { simulated: true };
  }

  const hash = await opts.walletClient.sendTransaction({
    to: opts.tx.to as `0x${string}`,
    data: opts.tx.data as Hex,
    value: opts.tx.value ? BigInt(opts.tx.value) : 0n,
    ...(opts.tx.gasLimit ? { gas: BigInt(opts.tx.gasLimit) } : {}),
  });
  logger.info(`sent ${opts.label}`, { hash });
  await opts.publicClient.waitForTransactionReceipt({ hash });
  return { hash, simulated: false };
}

export function stripNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

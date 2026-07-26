import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

function loadEnvFiles() {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), "../../../.env"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      // Prefer repo .env over inherited shell vars (common in IDE terminals).
      loadDotenv({ path: p, override: true });
      return;
    }
  }
  loadDotenv({ override: true });
}

loadEnvFiles();

const address = z.string().default("");

function normalizeOptionalAddress(value: string): string {
  const v = value.trim();
  if (!v || v.includes("YOUR")) return "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(v)) return "";
  return v;
}

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().default(11155111),
  RPC_URL: z
    .string()
    .default("https://ethereum-sepolia-rpc.publicnode.com"),
  PRIVATE_KEY: z.string().optional().default(""),
  WALLET_ADDRESS: address.optional().default(""),

  SAFE_ASSETS: z.string().default("USDC,USDT,DAI"),
  USDC_ADDRESS: address.default("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  USDT_ADDRESS: address.default("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
  DAI_ADDRESS: address.default("0x6B175474E89094C44Da98b954EedeAC495271d0F"),
  /** Destination wallet after exit + swap (flight capital) */
  SAFE_WALLET_ADDRESS: address.default(""),
  /** Demo / synthetic USD that should peg 1:1 to stables */
  SUSD_ADDRESS: address.default(""),
  /** Extra token addresses treated as USD-pegged for depeg checks */
  PEGGED_TOKENS: z.string().default(""),

  UNISWAP_API_KEY: z.string().optional().default(""),
  UNISWAP_TRADE_API_BASE_URL: z
    .string()
    .default("https://trade-api.gateway.uniswap.org/v1"),
  UNISWAP_LP_API_BASE_URL: z
    .string()
    .default("https://liquidity.api.uniswap.org"),

  WATCHED_POOLS: z.string().default(""),
  WATCHED_POSITION_IDS: z.string().default(""),
  PORTFOLIO_TOKENS: z.string().default(""),

  GRAPH_GATEWAY_URL: z
    .string()
    .default("https://gateway.thegraph.com/api"),
  GRAPH_API_KEY: z.string().default(""),
  GRAPH_UNISWAP_SUBGRAPH: z
    .string()
    .default("5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV"),
  GRAPH_X402_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  SCAN_INTERVAL_MS: z.coerce.number().default(15000),
  PRICE_DROP_THRESHOLD_PCT: z.coerce.number().default(15),
  DEPEG_THRESHOLD_BPS: z.coerce.number().default(100),
  POOL_TVL_DROP_THRESHOLD_PCT: z.coerce.number().default(25),
  POOL_MIN_TVL_USD: z.coerce.number().default(10),
  PANIC_CONFIRMATIONS: z.coerce.number().default(2),
  EXECUTION_MODE: z.enum(["dry_run", "live"]).default("dry_run"),
  AGENT_ROLE: z.enum(["scanner", "executor"]).default("scanner"),
  SLIPPAGE_TOLERANCE: z.coerce.number().default(1),

  // X / Twitter security intel (e.g. @blockaid_)
  X_BEARER_TOKEN: z.string().default(""),
  X_WATCH_ACCOUNTS: z.string().default("blockaid_"),
  X_POLL_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  X_MAX_POSTS: z.coerce.number().default(10),
  // Optional path to a JSON fixture for demo without X API credentials
  X_FIXTURE_PATH: z.string().default(""),

  GLIDER_WEBHOOK_SECRET: z.string().default(""),
  FORTA_API_KEY: z.string().default(""),
  FORTA_API_URL: z
    .string()
    .default("https://api.forta.network/graphql"),
  FORTA_POLL_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  ZG_COMPUTE_MODE: z.enum(["router", "off"]).default("router"),
  ZG_ROUTER_API_KEY: z.string().default(""),
  ZG_ROUTER_BASE_URL: z.string().default("https://router-api.0g.ai/v1"),
  ZG_MODEL: z.string().default("qwen/qwen-2.5-7b-instruct"),
  ZG_SCORING_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  /** Minimum ms between 0G scoring calls (skips call when sooner). */
  ZG_MIN_INTERVAL_MS: z.coerce.number().default(60_000),
});

export type SentinelConfig = z.infer<typeof envSchema> & {
  safeAssets: string[];
  watchedPools: string[];
  watchedPositionIds: string[];
  portfolioTokens: string[];
  peggedTokens: string[];
  xWatchAccounts: string[];
};

import { loadPolicySettings } from "./settings.js";

let cached: SentinelConfig | null = null;

function buildFromEnv(): SentinelConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const e = parsed.data;
  const wallet = normalizeOptionalAddress(e.WALLET_ADDRESS);
  const mainnetDefaults = e.CHAIN_ID === 1;
  const usdc =
    normalizeOptionalAddress(e.USDC_ADDRESS) ||
    (mainnetDefaults
      ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
      : e.CHAIN_ID === 11155111
        ? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
        : "");
  const usdt =
    normalizeOptionalAddress(e.USDT_ADDRESS) ||
    (mainnetDefaults ? "0xdAC17F958D2ee523a2206206994597C13D831ec7" : "");
  const dai =
    normalizeOptionalAddress(e.DAI_ADDRESS) ||
    (mainnetDefaults ? "0x6B175474E89094C44Da98b954EedeAC495271d0F" : "");
  const safeWallet = normalizeOptionalAddress(e.SAFE_WALLET_ADDRESS);
  const susd = normalizeOptionalAddress(e.SUSD_ADDRESS);
  return {
    ...e,
    WALLET_ADDRESS: wallet,
    USDC_ADDRESS: usdc,
    USDT_ADDRESS: usdt,
    DAI_ADDRESS: dai,
    SAFE_WALLET_ADDRESS: safeWallet,
    SUSD_ADDRESS: susd,
    PRIVATE_KEY:
      !e.PRIVATE_KEY || e.PRIVATE_KEY.includes("YOUR") ? "" : e.PRIVATE_KEY,
    safeAssets: e.SAFE_ASSETS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    watchedPools: e.WATCHED_POOLS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    watchedPositionIds: e.WATCHED_POSITION_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    portfolioTokens: e.PORTFOLIO_TOKENS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[a-fA-F0-9]{40}$/.test(s)),
    peggedTokens: e.PEGGED_TOKENS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[a-fA-F0-9]{40}$/.test(s)),
    xWatchAccounts: e.X_WATCH_ACCOUNTS.split(",")
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean),
  };
}

/** Sync env-backed config. Prefer getEffectiveConfig() for policy overrides. */
export function getConfig(force = false): SentinelConfig {
  if (cached && !force) return cached;
  cached = buildFromEnv();
  return cached;
}

/** Env config merged with dashboard runtime policy (thresholds, stables, mode). */
export async function getEffectiveConfig(): Promise<SentinelConfig> {
  const base = getConfig();
  const policy = await loadPolicySettings();
  return {
    ...base,
    SAFE_ASSETS: policy.safeAssets.join(","),
    safeAssets: policy.safeAssets,
    PRICE_DROP_THRESHOLD_PCT: policy.priceDropThresholdPct,
    DEPEG_THRESHOLD_BPS: policy.depegThresholdBps,
    POOL_TVL_DROP_THRESHOLD_PCT: policy.poolTvlDropThresholdPct,
    POOL_MIN_TVL_USD: policy.poolMinTvlUsd,
    PANIC_CONFIRMATIONS: policy.panicConfirmations,
    SLIPPAGE_TOLERANCE: policy.slippageTolerance,
    EXECUTION_MODE: policy.executionMode,
    FORTA_POLL_ENABLED: policy.sources.forta,
    X_POLL_ENABLED: policy.sources.x,
    ZG_SCORING_ENABLED: policy.sources.zg,
  };
}

export function isDryRun(): boolean {
  // sync path for CLI; async callers should check policy.executionMode
  return getConfig().EXECUTION_MODE !== "live";
}

export async function isDryRunAsync(): Promise<boolean> {
  const policy = await loadPolicySettings();
  return policy.executionMode !== "live";
}

export function csvAddresses(value: string): `0x${string}`[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is `0x${string}` => /^0x[a-fA-F0-9]{40}$/.test(s));
}

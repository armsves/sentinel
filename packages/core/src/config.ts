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
      loadDotenv({ path: p });
      return;
    }
  }
  loadDotenv();
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
  CHAIN_ID: z.coerce.number().default(1),
  RPC_URL: z.string().min(1),
  PRIVATE_KEY: z.string().optional().default(""),
  WALLET_ADDRESS: address.optional().default(""),

  SAFE_ASSETS: z.string().default("USDC,USDT,DAI"),
  USDC_ADDRESS: address.default("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  USDT_ADDRESS: address.default("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
  DAI_ADDRESS: address.default("0x6B175474E89094C44Da98b954EedeAC495271d0F"),

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
  POOL_MIN_TVL_USD: z.coerce.number().default(50_000),
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
});

export type SentinelConfig = z.infer<typeof envSchema> & {
  safeAssets: string[];
  watchedPools: string[];
  watchedPositionIds: string[];
  portfolioTokens: string[];
  xWatchAccounts: string[];
};

let cached: SentinelConfig | null = null;

export function getConfig(force = false): SentinelConfig {
  if (cached && !force) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const e = parsed.data;
  const wallet = normalizeOptionalAddress(e.WALLET_ADDRESS);
  const usdc = normalizeOptionalAddress(e.USDC_ADDRESS) || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const usdt = normalizeOptionalAddress(e.USDT_ADDRESS) || "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const dai = normalizeOptionalAddress(e.DAI_ADDRESS) || "0x6B175474E89094C44Da98b954EedeAC495271d0F";
  cached = {
    ...e,
    WALLET_ADDRESS: wallet,
    USDC_ADDRESS: usdc,
    USDT_ADDRESS: usdt,
    DAI_ADDRESS: dai,
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
    xWatchAccounts: e.X_WATCH_ACCOUNTS.split(",")
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean),
  };
  return cached;
}

export function csvAddresses(value: string): `0x${string}`[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is `0x${string}` => /^0x[a-fA-F0-9]{40}$/.test(s));
}

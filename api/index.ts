/**
 * Lightweight public demo API for Vercel.
 * Avoids pulling Uniswap/0G/executor into the serverless bundle.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  isPublicDemoRuntime,
  listActivity,
  loadPolicySettings,
  runPublicDryRunDemo,
  savePolicySettings,
  useRedisStore,
  type PolicySettings,
} from "@sentinel/core";
import { chatWith0G } from "@sentinel/zg";

if (process.env.VERCEL) {
  process.env.PUBLIC_DEMO ??= "true";
}

const app = new Hono().basePath("/api");
app.use("*", cors());

function envList(key: string): string[] {
  return (process.env[key] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

app.get("/health", async (c) => {
  const policy = await loadPolicySettings();
  const watchedPools = envList("WATCHED_POOLS");
  return c.json({
    ok: true,
    chainId: Number(process.env.CHAIN_ID ?? 11155111),
    executionMode: policy.executionMode,
    dryRun: true,
    store: useRedisStore() ? "redis" : "file",
    publicDemo: isPublicDemoRuntime() || true,
    watchedPools: watchedPools.length,
    watchedPositions: envList("WATCHED_POSITION_IDS").length,
    safeWallet: process.env.SAFE_WALLET_ADDRESS?.trim() || null,
    policy,
  });
});

app.get("/settings", async (c) => {
  const policy = await loadPolicySettings();
  return c.json({ policy });
});

app.put("/settings", async (c) => {
  const body = await c.req.json<Partial<PolicySettings>>();
  const policy = await savePolicySettings(body);
  return c.json({ policy });
});

app.get("/activity", async (c) => {
  const since = Number(c.req.query("since") ?? 0);
  const limit = Number(c.req.query("limit") ?? 80);
  const events = await listActivity({
    since: Number.isFinite(since) ? since : 0,
    limit: Number.isFinite(limit) ? limit : 80,
  });
  return c.json({ events });
});

app.get("/queue", async (c) => c.json({ items: [] }));

app.get("/positions", async (c) => {
  const watchedPools = envList("WATCHED_POOLS").map((p) => p.toLowerCase());
  const wallet = process.env.WALLET_ADDRESS?.trim() || "";
  const safeWallet = process.env.SAFE_WALLET_ADDRESS?.trim() || null;
  const susd = process.env.SUSD_ADDRESS?.trim() || "";
  const usdc = process.env.USDC_ADDRESS?.trim() || "";
  return c.json({
    address: wallet,
    safeWallet,
    watchedPools,
    publicDemo: true,
    positions: watchedPools.map((pool) => ({
      protocol: "uniswap-v3",
      pool,
      token0Address: susd,
      token1Address: usdc,
      note: "Watched pool (NFT positions require local API + RPC)",
    })),
  });
});

app.post("/trigger", async (c) => {
  type TriggerBody = {
    kind?: "stop_loss" | "depeg" | "tvl_drop" | "exploit";
    value?: number;
    saveThreshold?: boolean;
    threshold?: number;
  };
  const body = await c.req.json<TriggerBody>().catch((): TriggerBody => ({}));
  const kind = body.kind ?? "stop_loss";
  const policy = await loadPolicySettings();
  const threshold =
    body.threshold ??
    (kind === "stop_loss"
      ? policy.priceDropThresholdPct
      : kind === "depeg"
        ? policy.depegThresholdBps
        : kind === "tvl_drop"
          ? policy.poolTvlDropThresholdPct
          : 0);
  const value =
    body.value ??
    (kind === "depeg"
      ? threshold + 80
      : threshold + Math.max(5, threshold * 0.25));

  const result = await runPublicDryRunDemo({
    kind,
    value,
    threshold,
    saveThreshold: body.saveThreshold !== false,
  });
  return c.json(result);
});

app.post("/demo/run", async (c) => {
  const body = await c.req
    .json<{ scenario?: "depeg" | "exploit" | "both" }>()
    .catch(() => ({ scenario: "depeg" as const }));
  const result = await runPublicDryRunDemo({
    kind: body.scenario ?? "depeg",
  });
  return c.json(result);
});

app.post("/chat", async (c) => {
  const body = await c.req
    .json<{
      message?: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
    }>()
    .catch(() => ({} as { message?: string }));
  const message = body.message?.trim();
  if (!message) return c.json({ error: "message is required" }, 400);
  try {
    const result = await chatWith0G({
      message,
      history: body.history?.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

function parseTokenAmount(amount: string, decimals: number): string {
  const cleaned = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error("amount must be a positive decimal number");
  }
  const [whole, frac = ""] = cleaned.split(".");
  const padded = `${frac}${"0".repeat(decimals)}`.slice(0, decimals);
  const raw = `${whole}${padded}`.replace(/^0+(?=\d)/, "") || "0";
  return raw;
}

app.post("/actions/swap", async (c) => {
  type SwapBody = {
    tokenIn?: string;
    tokenOut?: string;
    amount?: string;
    decimals?: number;
  };
  const body = await c.req.json<SwapBody>().catch((): SwapBody => ({}));
  const tokenIn = body.tokenIn?.trim();
  const tokenOut = body.tokenOut?.trim();
  const amount = body.amount?.trim();
  const decimals = body.decimals ?? 18;
  if (!tokenIn || !tokenOut || !amount) {
    return c.json({ error: "tokenIn, tokenOut, and amount are required" }, 400);
  }

  const apiKey = process.env.UNISWAP_API_KEY?.trim();
  if (!apiKey) {
    return c.json({ error: "UNISWAP_API_KEY is not configured" }, 500);
  }

  const chainId = Number(process.env.CHAIN_ID ?? 11155111);
  const swapper =
    process.env.WALLET_ADDRESS?.trim() ||
    "0x0000000000000000000000000000000000000001";
  const base = (
    process.env.UNISWAP_TRADE_API_BASE_URL ||
    "https://trade-api.gateway.uniswap.org/v1"
  ).replace(/\/$/, "");

  try {
    const rawAmount = parseTokenAmount(amount, decimals);
    const res = await fetch(`${base}/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-api-key": apiKey,
        "x-universal-router-version": "2.0",
      },
      body: JSON.stringify({
        tokenIn,
        tokenOut,
        tokenInChainId: String(chainId),
        tokenOutChainId: String(chainId),
        amount: rawAmount,
        type: "EXACT_INPUT",
        swapper,
        slippageTolerance: 1,
        routingPreference: "BEST_PRICE",
        protocols: ["V3"],
      }),
    });
    const text = await res.text();
    let json: {
      routing?: string;
      requestId?: string;
      quote?: Record<string, unknown>;
      error?: unknown;
      detail?: unknown;
    } = {};
    try {
      json = text ? (JSON.parse(text) as typeof json) : {};
    } catch {
      return c.json(
        { error: `Uniswap quote returned non-JSON (${res.status})` },
        502,
      );
    }
    if (!res.ok) {
      return c.json(
        {
          error: `Uniswap quote failed (${res.status}): ${JSON.stringify(json.error ?? json.detail ?? json)}`,
        },
        502,
      );
    }

    const quote = (json.quote ?? {}) as {
      input?: { amount?: string; token?: string };
      output?: { amount?: string; token?: string; minimumAmount?: string };
      gasFee?: string;
      gasFeeUSD?: string | number;
      gasUseEstimate?: string | number;
      routeString?: string;
      priceImpact?: number | string;
      slippage?: number | string;
    };
    const outRaw = quote.output?.amount;
    const usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".toLowerCase();
    const outDecimals = tokenOut.toLowerCase() === usdc ? 6 : 18;
    const outHuman =
      outRaw != null
        ? (Number(outRaw) / 10 ** outDecimals).toFixed(
            Math.min(8, outDecimals),
          )
        : null;

    // Uniswap's gasFeeUSD on testnets prices gas as if mainnet ETH —
    // prefer native units from gasFee (wei). USD only trusted on mainnet.
    let gasFeeWei: string | null = null;
    let gasFeeEth: string | null = null;
    if (quote.gasFee != null && /^\d+$/.test(String(quote.gasFee))) {
      gasFeeWei = String(quote.gasFee);
      const eth = Number(gasFeeWei) / 1e18;
      gasFeeEth = eth.toFixed(eth >= 0.001 ? 6 : 8);
    }
    const isMainnet = chainId === 1;
    const gasFeeUSD = isMainnet
      ? quote.gasFeeUSD != null
        ? Number(quote.gasFeeUSD)
        : null
      : null;

    return c.json({
      mode: "dry_run",
      routing: json.routing ?? "unknown",
      requestId: json.requestId ?? null,
      simulated: true,
      publicDemo: true,
      tokenIn,
      tokenOut,
      amountIn: amount,
      amountOut: outHuman,
      amountOutRaw: outRaw ?? null,
      minimumAmountOut: quote.output?.minimumAmount ?? null,
      gasFeeWei,
      gasFeeEth,
      gasFeeUSD,
      gasUseEstimate: quote.gasUseEstimate ?? null,
      route: quote.routeString ?? null,
      priceImpact: quote.priceImpact ?? null,
      chainId,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

app.notFound((c) => c.json({ error: `not found: ${c.req.path}` }, 404));
app.onError((err, c) =>
  c.json({ error: err instanceof Error ? err.message : String(err) }, 500),
);

/** Vercel Web Handler (Fluid): must export fetch, not Node (req,res). */
export default {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request);
  },
};

export { app };

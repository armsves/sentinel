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

/** Vercel Web Handler (Fluid): must export fetch, not Node (req,res). */
export default {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request);
  },
};

export { app };

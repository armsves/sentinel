import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  buildPanicEvent,
  createClients,
  enqueuePanic,
  getConfig,
  getEffectiveConfig,
  isDryRunAsync,
  listQueue,
  loadPolicySettings,
  logger,
  savePolicySettings,
  type NormalizedSignal,
  type PolicySettings,
} from "@sentinel/core";
import {
  BLOCKAID_VERUS_FIXTURE,
  GLIDER_FIXTURE,
  normalizeGliderWebhook,
  postsToSignals,
  type GliderWebhookPayload,
} from "@sentinel/monitors";
import { scoreSignalsWith0G, chatWith0G } from "@sentinel/zg";
import {
  executeSwap,
  listOwnerPositions,
} from "@sentinel/uniswap";
import { parseUnits } from "viem";
import { timingSafeEqual } from "node:crypto";

const app = new Hono();
app.use("*", cors());

function checkGliderSecret(header: string | undefined): boolean {
  const secret = getConfig().GLIDER_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!header) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
app.get("/api/health", async (c) => {
  const cfg = await getEffectiveConfig();
  const policy = await loadPolicySettings();
  return c.json({
    ok: true,
    chainId: cfg.CHAIN_ID,
    executionMode: cfg.EXECUTION_MODE,
    dryRun: cfg.EXECUTION_MODE !== "live",
    xAccounts: cfg.xWatchAccounts,
    xLive: Boolean(cfg.X_BEARER_TOKEN),
    watchedPools: cfg.watchedPools.length,
    watchedPositions: cfg.watchedPositionIds.length,
    policy,
  });
});

app.get("/api/settings", async (c) => {
  const policy = await loadPolicySettings();
  return c.json({ policy });
});

app.put("/api/settings", async (c) => {
  const body = await c.req.json<Partial<PolicySettings>>();
  const policy = await savePolicySettings(body);
  logger.info("policy settings updated", {
    safeAssets: policy.safeAssets,
    minPanicSeverity: policy.minPanicSeverity,
    priceDropThresholdPct: policy.priceDropThresholdPct,
    executionMode: policy.executionMode,
  });
  return c.json({ policy });
});

app.get("/api/queue", async (c) => {
  const items = await listQueue();
  return c.json({ items });
});

app.get("/api/positions", async (c) => {
  try {
    const { publicClient, address } = createClients();
    if (!address) {
      return c.json({ error: "WALLET_ADDRESS or PRIVATE_KEY required" }, 400);
    }
    const positions = await listOwnerPositions(publicClient, address);
    return c.json({ address, positions });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

app.post("/api/panic/simulate", async (c) => {
  const body = await c.req
    .json<{ source?: "x" | "glider" | "both" }>()
    .catch(() => ({ source: "both" as const }));
  const source = body.source ?? "both";
  const signals: NormalizedSignal[] = [];
  if (source === "x" || source === "both") {
    signals.push(...postsToSignals(BLOCKAID_VERUS_FIXTURE));
  }
  if (source === "glider" || source === "both") {
    signals.push(normalizeGliderWebhook(GLIDER_FIXTURE));
  }
  const zg = await scoreSignalsWith0G(signals);
  const event = await buildPanicEvent(signals, {
    zgScore: zg.score,
    zgRationale: zg.rationale,
    zgShouldPanic: zg.shouldPanic,
  });
  if (!event) {
    return c.json({ error: "policy did not create panic from fixture", zg }, 400);
  }
  const added = await enqueuePanic(event);
  return c.json({ added, event, zg });
});

app.post("/hooks/glider", async (c) => {
  const secret = c.req.header("x-glider-secret") ?? c.req.header("x-webhook-secret");
  if (!checkGliderSecret(secret ?? undefined)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const payload = (await c.req.json()) as GliderWebhookPayload;
  const signal = normalizeGliderWebhook(payload);
  logger.warn("glider webhook received", {
    severity: signal.severity,
    message: signal.message,
    addresses: signal.addresses,
  });
  const event = await buildPanicEvent([signal]);
  if (!event) {
    return c.json({ ok: true, enqueued: false, signal });
  }
  const added = await enqueuePanic(event);
  return c.json({ ok: true, enqueued: added, event, signal });
});

app.post("/api/glider/simulate", async (c) => {
  const signal = normalizeGliderWebhook(GLIDER_FIXTURE);
  const event = await buildPanicEvent([signal]);
  if (!event) {
    return c.json({ error: "policy rejected glider fixture" }, 400);
  }
  const added = await enqueuePanic(event);
  return c.json({ added, event, signal });
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{
    message?: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
  }>();
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

app.post("/api/actions/swap", async (c) => {
  const body = await c.req.json<{
    tokenIn: string;
    tokenOut: string;
    amount: string;
    decimals?: number;
  }>();
  try {
    const cfg = await getEffectiveConfig();
    const dryRun = await isDryRunAsync();
    const { publicClient, walletClient, address } = createClients({
      requireSigner: true,
    });
    if (!walletClient || !address) {
      return c.json({ error: "signer required" }, 400);
    }
    const decimals = body.decimals ?? 18;
    const amount = parseUnits(body.amount, decimals).toString();
    const result = await executeSwap({
      params: {
        tokenIn: body.tokenIn as `0x${string}`,
        tokenOut: body.tokenOut as `0x${string}`,
        amount,
        swapper: address,
        slippageTolerance: cfg.SLIPPAGE_TOLERANCE,
        routingPreference: "CLASSIC",
      },
      walletClient,
      publicClient,
      dryRun,
    });
    return c.json({
      mode: cfg.EXECUTION_MODE,
      routing: result.quote.routing,
      hash: result.hash,
      simulated: result.simulated,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

const port = Number(process.env.API_PORT ?? 8787);
logger.info("api starting", { port });
serve({ fetch: app.fetch, port });

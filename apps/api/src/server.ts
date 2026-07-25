import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  buildPanicEvent,
  createClients,
  emitActivity,
  enqueuePanic,
  getConfig,
  getEffectiveConfig,
  isDryRunAsync,
  isPublicDemoRuntime,
  listActivity,
  listQueue,
  loadPolicySettings,
  logger,
  runPublicDryRunDemo,
  savePolicySettings,
  useRedisStore,
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
    safeWallet: cfg.SAFE_WALLET_ADDRESS || null,
    portfolioTokens: cfg.portfolioTokens.length,
    policy,
    store: useRedisStore() ? "redis" : "file",
    publicDemo: isPublicDemoRuntime(),
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

app.get("/api/activity", async (c) => {
  const since = Number(c.req.query("since") ?? 0);
  const limit = Number(c.req.query("limit") ?? 80);
  const events = await listActivity({
    since: Number.isFinite(since) ? since : 0,
    limit: Number.isFinite(limit) ? limit : 80,
  });
  return c.json({ events });
});

app.post("/api/trigger", async (c) => {
  type TriggerBody = {
    kind?: "stop_loss" | "depeg" | "tvl_drop" | "exploit";
    value?: number;
    saveThreshold?: boolean;
    threshold?: number;
    execute?: boolean;
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
    (kind === "depeg" ? threshold + 80 : threshold + Math.max(5, threshold * 0.25));

  // Cloud / Vercel: simulated dry-run anyone can click (Redis-backed activity)
  if (isPublicDemoRuntime()) {
    try {
      const result = await runPublicDryRunDemo({
        kind,
        value,
        threshold,
        saveThreshold: body.saveThreshold !== false,
      });
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  }

  if (body.saveThreshold && kind !== "exploit") {
    const patch: Partial<PolicySettings> =
      kind === "stop_loss"
        ? { priceDropThresholdPct: threshold }
        : kind === "depeg"
          ? { depegThresholdBps: threshold }
          : { poolTvlDropThresholdPct: threshold };
    await savePolicySettings(patch);
    await emitActivity({
      agent: "api",
      phase: "policy",
      level: "info",
      message: `Policy threshold updated for ${kind}`,
      data: patch,
    });
  }

  await emitActivity({
    agent: "api",
    phase: "trigger",
    level: "warn",
    message: `Dashboard trigger: ${kind} value=${value} threshold=${threshold}`,
    data: { kind, value, threshold, execute: body.execute !== false },
  });

  // Local: shell to executor for real dry_run / live path
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const execFileAsync = promisify(execFile);
  const root = [process.cwd(), resolve(process.cwd(), "../.."), resolve(process.cwd(), "../../..")].find(
    (dir) => existsSync(resolve(dir, "pnpm-workspace.yaml")),
  );
  if (!root) return c.json({ error: "monorepo root not found" }, 500);

  const args = [
    "--filter",
    "@sentinel/executor",
    "start",
    "trigger",
    "--",
    "--kind",
    kind,
    "--value",
    String(value),
    "--threshold",
    String(threshold),
    "--json",
  ];
  if (body.execute === false) args.push("--enqueue-only");

  try {
    const { stdout, stderr } = await execFileAsync("pnpm", args, {
      cwd: root,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    });
    if (stderr) logger.info("trigger stderr", { stderr: stderr.slice(0, 2000) });
    const marker = stdout.match(
      /___SENTINEL_DEMO_JSON___\n([\s\S]*?)\n___END_DEMO_JSON___/,
    );
    if (!marker?.[1]) {
      return c.json(
        { error: `trigger produced no JSON\n${stdout.slice(-1500)}` },
        500,
      );
    }
    return c.json(JSON.parse(marker[1]));
  } catch (err) {
    let msg = err instanceof Error ? err.message : String(err);
    if (err && typeof err === "object") {
      const e = err as { stderr?: string; message?: string };
      if (e.stderr) msg = e.stderr;
      else if (e.message) msg = e.message;
    }
    return c.json({ error: msg }, 500);
  }
});

app.get("/api/positions", async (c) => {
  try {
    const cfg = getConfig();
    if (
      isPublicDemoRuntime() &&
      !cfg.PRIVATE_KEY &&
      !cfg.WALLET_ADDRESS
    ) {
      return c.json({ address: "", positions: [], publicDemo: true });
    }
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
  const cfg = getConfig();
  const signals: NormalizedSignal[] = [];
  if (source === "x" || source === "both") {
    signals.push(...postsToSignals(BLOCKAID_VERUS_FIXTURE));
  }
  if (source === "glider" || source === "both") {
    signals.push(normalizeGliderWebhook(GLIDER_FIXTURE));
  }
  const zg = await scoreSignalsWith0G(signals);
  const positions = cfg.watchedPools.map((pool) => ({
    chainId: cfg.CHAIN_ID,
    pool,
    tokens: [cfg.SUSD_ADDRESS, cfg.USDC_ADDRESS].filter(Boolean),
  }));
  const event = await buildPanicEvent(signals, {
    positions,
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
        routingPreference: "BEST_PRICE",
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

app.post("/api/demo/run", async (c) => {
  const body = await c.req
    .json<{
      scenario?: "depeg" | "exploit" | "both";
      execute?: boolean;
    }>()
    .catch(() => ({} as { scenario?: "depeg" | "exploit" | "both"; execute?: boolean }));
  const scenario = body.scenario ?? "depeg";
  const execute = body.execute !== false;

  if (isPublicDemoRuntime()) {
    try {
      const result = await runPublicDryRunDemo({ kind: scenario });
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  }

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const execFileAsync = promisify(execFile);
    const root = [process.cwd(), resolve(process.cwd(), "../.."), resolve(process.cwd(), "../../..")].find(
      (dir) => existsSync(resolve(dir, "pnpm-workspace.yaml")),
    );
    if (!root) throw new Error("monorepo root not found");

    const args = [
      "--filter",
      "@sentinel/executor",
      "start",
      "demo",
      "--",
      "--scenario",
      scenario,
      "--json",
    ];
    if (!execute) args.push("--enqueue-only");

    const { stdout, stderr } = await execFileAsync("pnpm", args, {
      cwd: root,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    });
    if (stderr) {
      logger.info("demo stderr", { stderr: stderr.slice(0, 2000) });
    }
    const marker = stdout.match(/___SENTINEL_DEMO_JSON___\n([\s\S]*?)\n___END_DEMO_JSON___/);
    if (!marker?.[1]) {
      throw new Error(`demo produced no JSON result\n${stdout.slice(-1500)}`);
    }
    const result = JSON.parse(marker[1]) as Record<string, unknown>;
    logger.warn("demo run finished", {
      id: (result.event as { id?: string } | undefined)?.id,
      scenario,
      queueStatus: result.queueStatus,
    });
    return c.json(result);
  } catch (err) {
    let msg = err instanceof Error ? err.message : String(err);
    if (err && typeof err === "object") {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      if (e.stderr) msg = e.stderr;
      else if (e.message) msg = e.message;
    }
    logger.error("demo run failed", { error: msg });
    return c.json({ error: msg }, 500);
  }
});

export { app };

const port = Number(process.env.API_PORT ?? 8787);
if (!process.env.VERCEL) {
  logger.info("api starting", { port, store: useRedisStore() ? "redis" : "file" });
  serve({ fetch: app.fetch, port });
}
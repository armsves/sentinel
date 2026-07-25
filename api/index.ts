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

if (process.env.VERCEL) {
  process.env.PUBLIC_DEMO ??= "true";
}

const app = new Hono().basePath("/api");
app.use("*", cors());

app.get("/health", async (c) => {
  const policy = await loadPolicySettings();
  return c.json({
    ok: true,
    chainId: Number(process.env.CHAIN_ID ?? 11155111),
    executionMode: policy.executionMode,
    dryRun: true,
    store: useRedisStore() ? "redis" : "file",
    publicDemo: isPublicDemoRuntime() || true,
    watchedPools: (process.env.WATCHED_POOLS ?? "")
      .split(",")
      .filter(Boolean).length,
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

app.get("/positions", async (c) =>
  c.json({ address: "", positions: [], publicDemo: true }),
);

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

app.post("/chat", async (c) =>
  c.json({
    reply:
      "Public demo mode: chat is available on the local API with a 0G key. Use Fire stop-loss to run the exit simulation.",
    model: "public-demo",
    provider: "public-demo",
  }),
);

/** Vercel Web Handler (Fluid): must export fetch, not Node (req,res). */
export default {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request);
  },
};

export { app };

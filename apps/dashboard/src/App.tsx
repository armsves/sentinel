import { useCallback, useEffect, useState, type FormEvent } from "react";

type Health = {
  ok: boolean;
  chainId: number;
  executionMode: string;
  dryRun: boolean;
  xAccounts: string[];
  xLive: boolean;
  watchedPools: number;
  watchedPositions: number;
  store?: string;
  publicDemo?: boolean;
};

type PolicySettings = {
  safeAssets: Array<"USDC" | "USDT" | "DAI">;
  priceDropThresholdPct: number;
  depegThresholdBps: number;
  poolTvlDropThresholdPct: number;
  poolMinTvlUsd: number;
  panicConfirmations: number;
  minPanicSeverity: "low" | "medium" | "high" | "critical";
  slippageTolerance: number;
  executionMode: "dry_run" | "live";
  actions: {
    withdrawLp: boolean;
    swapToStables: boolean;
    transferToSafe: boolean;
  };
  sources: {
    graph: boolean;
    x: boolean;
    glider: boolean;
    forta: boolean;
    zg: boolean;
  };
};

type QueueItem = {
  event: {
    id: string;
    severity: string;
    mode: string;
    reasons: Array<{ source: string; signal: string }>;
  };
  status: string;
  enqueuedAt: number;
};

type Position = {
  protocol: string;
  nftTokenId?: string;
  token0Address: string;
  token1Address: string;
  liquidity?: string;
  feeTier?: number;
};

type DemoPlanStep = {
  step: number;
  title: string;
  detail: string;
  status: "planned" | "done" | "skipped" | "failed";
};

type DemoRunResult = {
  scenario: string;
  label: string;
  mode: string;
  event: { id: string; zgScore?: number; zgRationale?: string };
  executed: boolean;
  queueStatus?: string;
  plan: DemoPlanStep[];
  safeWallet: string | null;
};

type ActivityEvent = {
  id: string;
  ts: number;
  agent: string;
  phase: string;
  level: string;
  message: string;
  data?: Record<string, unknown>;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
  /\/$/,
  "",
) ?? "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as T;
}

const STABLES: Array<"USDC" | "USDT" | "DAI"> = ["USDC", "USDT", "DAI"];

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [wallet, setWallet] = useState<string>("");
  const [policy, setPolicy] = useState<PolicySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [demoScenario, setDemoScenario] = useState<"depeg" | "exploit" | "both">(
    "depeg",
  );
  const [demoResult, setDemoResult] = useState<DemoRunResult | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [stopLossPct, setStopLossPct] = useState(15);
  const [breachPct, setBreachPct] = useState(22);
  const [depegBps, setDepegBps] = useState(100);
  const [breachBps, setBreachBps] = useState(180);
  const [tvlDropPct, setTvlDropPct] = useState(25);
  const [breachTvlPct, setBreachTvlPct] = useState(40);
  const [chatInput, setChatInput] = useState("Say hi and confirm you are running on 0G Compute.");
  const [chatLog, setChatLog] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const [swap, setSwap] = useState({
    tokenIn: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    amount: "0.01",
    decimals: "18",
  });

  const refresh = useCallback(async () => {
    try {
      const [h, q, p, s] = await Promise.all([
        api<Health>("/api/health"),
        api<{ items: QueueItem[] }>("/api/queue"),
        api<{ address: string; positions: Position[] }>("/api/positions").catch(
          () => ({ address: "", positions: [] as Position[] }),
        ),
        api<{ policy: PolicySettings }>("/api/settings"),
      ]);
      setHealth(h);
      setQueue(q.items);
      setPositions(p.positions);
      setWallet(p.address);
      setPolicy(s.policy);
      setStopLossPct(s.policy.priceDropThresholdPct);
      setDepegBps(s.policy.depegThresholdBps);
      setTvlDropPct(s.policy.poolTvlDropThresholdPct);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshActivity = useCallback(async () => {
    try {
      const res = await api<{ events: ActivityEvent[] }>("/api/activity?limit=60");
      setActivity(res.events);
    } catch {
      /* keep prior */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshActivity();
    const slow = setInterval(() => void refresh(), 10_000);
    const fast = setInterval(() => void refreshActivity(), 2_000);
    return () => {
      clearInterval(slow);
      clearInterval(fast);
    };
  }, [refresh, refreshActivity]);

  useEffect(() => {
    if (!policy) return;
    setBreachPct((v) =>
      v <= policy.priceDropThresholdPct
        ? Math.max(policy.priceDropThresholdPct + 5, Math.round(policy.priceDropThresholdPct * 1.4))
        : v,
    );
    setBreachBps((v) =>
      v <= policy.depegThresholdBps ? policy.depegThresholdBps + 80 : v,
    );
    setBreachTvlPct((v) =>
      v <= policy.poolTvlDropThresholdPct
        ? Math.max(
            policy.poolTvlDropThresholdPct + 5,
            Math.round(policy.poolTvlDropThresholdPct * 1.4),
          )
        : v,
    );
  }, [
    policy?.priceDropThresholdPct,
    policy?.depegThresholdBps,
    policy?.poolTvlDropThresholdPct,
  ]);

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    if (!policy) return;
    setBusy(true);
    try {
      const res = await api<{ policy: PolicySettings }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(policy),
      });
      setPolicy(res.policy);
      setMessage("Settings saved. Scanner/executor will use them on next tick.");
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleStable(sym: "USDC" | "USDT" | "DAI") {
    if (!policy) return;
    const has = policy.safeAssets.includes(sym);
    const next = has
      ? policy.safeAssets.filter((s) => s !== sym)
      : [...policy.safeAssets, sym];
    // preserve priority order USDC, USDT, DAI
    const ordered = STABLES.filter((s) => next.includes(s));
    setPolicy({ ...policy, safeAssets: ordered.length ? ordered : ["USDC"] });
  }

  async function simulatePanic() {
    setBusy(true);
    try {
      const res = await api<{ added: boolean; event: { id: string } }>(
        "/api/panic/simulate",
        { method: "POST", body: "{}" },
      );
      setMessage(
        res.added
          ? `Enqueued panic ${res.event.id}`
          : `Panic suppressed (cooldown/duplicate): ${res.event.id}`,
      );
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runPresentationDemo(execute: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const res = await api<DemoRunResult>("/api/demo/run", {
        method: "POST",
        body: JSON.stringify({ scenario: demoScenario, execute }),
      });
      setDemoResult(res);
      setMessage(
        execute
          ? `Demo ${res.queueStatus ?? "done"} · ${res.event.id} · mode=${res.mode}`
          : `Incident queued ${res.event.id} — run Execute or pnpm demo`,
      );
      await refresh();
      await refreshActivity();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function triggerBot(
    kind: "stop_loss" | "depeg" | "tvl_drop" | "exploit",
  ) {
    setBusy(true);
    setMessage("");
    try {
      const payload =
        kind === "stop_loss"
          ? {
              kind,
              threshold: stopLossPct,
              value: breachPct,
              saveThreshold: true,
              execute: true,
            }
          : kind === "depeg"
            ? {
                kind,
                threshold: depegBps,
                value: breachBps,
                saveThreshold: true,
                execute: true,
              }
            : kind === "tvl_drop"
              ? {
                  kind,
                  threshold: tvlDropPct,
                  value: breachTvlPct,
                  saveThreshold: true,
                  execute: true,
                }
              : { kind, execute: true };

      const res = await api<DemoRunResult>("/api/trigger", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setDemoResult(res);
      setMessage(`Triggered ${kind} → ${res.queueStatus ?? "done"} · ${res.event.id}`);
      await refresh();
      await refreshActivity();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runChat(e: FormEvent) {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    setBusy(true);
    const nextHistory = [...chatLog, { role: "user" as const, content: text }];
    setChatLog(nextHistory);
    setChatInput("");
    try {
      const res = await api<{ reply: string; model: string; provider: string }>(
        "/api/chat",
        {
          method: "POST",
          body: JSON.stringify({
            message: text,
            history: nextHistory.slice(0, -1),
          }),
        },
      );
      setChatLog([
        ...nextHistory,
        { role: "assistant", content: `${res.reply}\n\n— ${res.provider} · ${res.model}` },
      ]);
    } catch (err) {
      setChatLog([
        ...nextHistory,
        {
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function runSwap(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{
        mode: string;
        routing: string;
        simulated: boolean;
        hash?: string;
      }>("/api/actions/swap", {
        method: "POST",
        body: JSON.stringify({
          tokenIn: swap.tokenIn,
          tokenOut: swap.tokenOut,
          amount: swap.amount,
          decimals: Number(swap.decimals),
        }),
      });
      setMessage(JSON.stringify(res, null, 2));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <h1 className="brand">SENTINEL</h1>
      <p className="tagline">
        Panic-button control surface. Tune threat thresholds and exit actions,
        then let the agent withdraw Uniswap liquidity toward stables.
      </p>

      <div className="status-row">
        <div className={`pill ${health?.dryRun ? "dry" : "live"}`}>
          mode <strong>{policy?.executionMode ?? health?.executionMode ?? "…"}</strong>
        </div>
        {health?.publicDemo ? (
          <div className="pill dry">
            demo <strong>public dry-run</strong>
          </div>
        ) : null}
        <div className="pill">
          store <strong>{health?.store ?? "…"}</strong>
        </div>
        <div className="pill">
          min threat <strong>{policy?.minPanicSeverity ?? "…"}</strong>
        </div>
        <div className="pill">
          stop-loss <strong>{policy ? `${policy.priceDropThresholdPct}%` : "…"}</strong>
        </div>
        <div className="pill">
          exit{" "}
          <strong>{policy?.safeAssets.join(" → ") ?? "…"}</strong>
        </div>
        <div className="pill">
          wallet{" "}
          <strong>
            {wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "unset"}
          </strong>
        </div>
      </div>

      <section className="panel demo-panel">
        <h2>Trigger the bot</h2>
        <p className="hint">
          Set a threshold, simulate a breach past it, and the agent runs the
          exit plan. Watch the <strong>Live agent feed</strong> below — every
          detect → score → withdraw → swap → transfer step streams here while
          the worker runs.
        </p>
        <div className="trigger-grid">
          <div className="trigger-card">
            <h3>Stop-loss</h3>
            <label>
              Threshold %
              <input
                type="number"
                min={1}
                max={90}
                value={stopLossPct}
                onChange={(e) => setStopLossPct(Number(e.target.value))}
              />
            </label>
            <label>
              Simulated drop %
              <input
                type="number"
                min={1}
                max={99}
                value={breachPct}
                onChange={(e) => setBreachPct(Number(e.target.value))}
              />
            </label>
            <button
              className="primary"
              disabled={busy || breachPct <= stopLossPct}
              onClick={() => void triggerBot("stop_loss")}
            >
              Fire stop-loss
            </button>
          </div>
          <div className="trigger-card">
            <h3>Depeg</h3>
            <label>
              Threshold (bps)
              <input
                type="number"
                min={1}
                max={5000}
                value={depegBps}
                onChange={(e) => setDepegBps(Number(e.target.value))}
              />
            </label>
            <label>
              Simulated deviation (bps)
              <input
                type="number"
                min={1}
                max={10000}
                value={breachBps}
                onChange={(e) => setBreachBps(Number(e.target.value))}
              />
            </label>
            <button
              className="primary"
              disabled={busy || breachBps <= depegBps}
              onClick={() => void triggerBot("depeg")}
            >
              Fire depeg
            </button>
          </div>
          <div className="trigger-card">
            <h3>TVL drop</h3>
            <label>
              Threshold %
              <input
                type="number"
                min={1}
                max={90}
                value={tvlDropPct}
                onChange={(e) => setTvlDropPct(Number(e.target.value))}
              />
            </label>
            <label>
              Simulated drop %
              <input
                type="number"
                min={1}
                max={99}
                value={breachTvlPct}
                onChange={(e) => setBreachTvlPct(Number(e.target.value))}
              />
            </label>
            <button
              className="primary"
              disabled={busy || breachTvlPct <= tvlDropPct}
              onClick={() => void triggerBot("tvl_drop")}
            >
              Fire TVL drop
            </button>
          </div>
        </div>
        <div className="demo-controls" style={{ marginTop: "1rem" }}>
          <label>
            Full scenario
            <select
              value={demoScenario}
              onChange={(e) =>
                setDemoScenario(e.target.value as "depeg" | "exploit" | "both")
              }
            >
              <option value="depeg">sUSD depeg (X/Blockaid)</option>
              <option value="exploit">sUSD exploit / drain</option>
              <option value="both">Depeg + exploit + Glider</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void runPresentationDemo(true)}
          >
            ▶ Simulate incident &amp; execute
          </button>
          <button disabled={busy} onClick={() => void triggerBot("exploit")}>
            Fire exploit
          </button>
          <button disabled={busy} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {demoResult ? (
          <ol className="demo-plan">
            {demoResult.plan.map((step) => (
              <li key={step.step} className={`demo-step ${step.status}`}>
                <strong>
                  {step.status === "done"
                    ? "✓"
                    : step.status === "failed"
                      ? "✗"
                      : step.status === "skipped"
                        ? "·"
                        : "○"}{" "}
                  {step.title}
                </strong>
                <span>{step.detail}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section className="panel activity-panel">
        <div className="activity-head">
          <h2>Live agent feed</h2>
          <span className="live-dot">polling 2s</span>
        </div>
        <p className="hint">
          Scanner, demo triggers, and the executor publish steps here as they
          happen — this is what you show on stage while the bot works.
        </p>
        <div className="activity-log">
          {activity.length === 0 ? (
            <p className="empty">No activity yet — fire a stop-loss or run a demo.</p>
          ) : (
            [...activity].reverse().map((ev) => (
              <div key={ev.id} className={`activity-row ${ev.level}`}>
                <time>
                  {new Date(ev.ts).toLocaleTimeString()} · {ev.agent}/{ev.phase}
                </time>
                <span>{ev.message}</span>
              </div>
            ))
          )}
        </div>
      </section>

      {message ? <pre className="msg">{message}</pre> : null}

      {policy ? (
        <section className="panel">
          <h2>Policy settings</h2>
          <form className="form settings" onSubmit={(e) => void saveSettings(e)}>
            <div className="settings-grid">
              <label>
                Min panic severity
                <select
                  value={policy.minPanicSeverity}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      minPanicSeverity: e.target.value as PolicySettings["minPanicSeverity"],
                    })
                  }
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
              </label>

              <label>
                Execution mode
                <select
                  value={policy.executionMode}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      executionMode: e.target.value as "dry_run" | "live",
                    })
                  }
                >
                  <option value="dry_run">dry_run</option>
                  <option value="live">live</option>
                </select>
              </label>

              <label>
                Stop-loss / price drop %
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={policy.priceDropThresholdPct}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      priceDropThresholdPct: Number(e.target.value),
                    })
                  }
                />
              </label>

              <label>
                Depeg threshold (bps)
                <input
                  type="number"
                  min={1}
                  max={5000}
                  value={policy.depegThresholdBps}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      depegThresholdBps: Number(e.target.value),
                    })
                  }
                />
              </label>

              <label>
                Pool TVL drop %
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={policy.poolTvlDropThresholdPct}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      poolTvlDropThresholdPct: Number(e.target.value),
                    })
                  }
                />
              </label>

              <label>
                Panic confirmations (# sources)
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={policy.panicConfirmations}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      panicConfirmations: Number(e.target.value),
                    })
                  }
                />
              </label>

              <label>
                Slippage tolerance %
                <input
                  type="number"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={policy.slippageTolerance}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      slippageTolerance: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>

            <fieldset className="checks">
              <legend>Exit stables (priority order)</legend>
              {STABLES.map((sym) => (
                <label key={sym} className="check">
                  <input
                    type="checkbox"
                    checked={policy.safeAssets.includes(sym)}
                    onChange={() => toggleStable(sym)}
                  />
                  {sym}
                </label>
              ))}
            </fieldset>

            <fieldset className="checks">
              <legend>Exit actions</legend>
              <label className="check">
                <input
                  type="checkbox"
                  checked={policy.actions.withdrawLp}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      actions: { ...policy.actions, withdrawLp: e.target.checked },
                    })
                  }
                />
                Withdraw Uniswap LP
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={policy.actions.swapToStables}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      actions: {
                        ...policy.actions,
                        swapToStables: e.target.checked,
                      },
                    })
                  }
                />
                Swap residuals to stables
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={policy.actions.transferToSafe ?? true}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      actions: {
                        ...policy.actions,
                        transferToSafe: e.target.checked,
                      },
                    })
                  }
                />
                Transfer stables to safe wallet
              </label>
            </fieldset>

            <fieldset className="checks">
              <legend>Signal sources</legend>
              {(
                [
                  ["graph", "The Graph pools"],
                  ["x", "Blockaid / X"],
                  ["glider", "Glider webhooks"],
                  ["forta", "Forta poll"],
                  ["zg", "0G scoring"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="check">
                  <input
                    type="checkbox"
                    checked={policy.sources[key]}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        sources: { ...policy.sources, [key]: e.target.checked },
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            <button className="primary" disabled={busy} type="submit">
              Save policy
            </button>
          </form>
        </section>
      ) : null}

      <div className="grid" style={{ marginTop: "1.25rem" }}>
        <section className="panel">
          <h2>Panic queue</h2>
          {queue.length === 0 ? (
            <p className="empty">No panic events yet.</p>
          ) : (
            <ul className="list">
              {queue
                .slice()
                .reverse()
                .map((item) => (
                  <li key={item.event.id} className="item">
                    <div>
                      <span className={`sev-${item.event.severity}`}>
                        {item.event.severity}
                      </span>{" "}
                      · {item.status} · {item.event.mode}
                    </div>
                    <div className="meta">
                      {item.event.id}
                      <br />
                      {item.event.reasons
                        .map((r) => `${r.source}: ${r.signal.slice(0, 100)}`)
                        .join(" · ")}
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Uniswap positions</h2>
          {positions.length === 0 ? (
            <p className="empty">No v3 positions found (or RPC/wallet unset).</p>
          ) : (
            <ul className="list">
              {positions.map((p) => (
                <li
                  key={p.nftTokenId ?? `${p.token0Address}-${p.liquidity}`}
                  className="item"
                >
                  <div>
                    {p.protocol} NFT #{p.nftTokenId} · fee {p.feeTier}
                  </div>
                  <div className="meta">
                    {p.token0Address.slice(0, 10)}… / {p.token1Address.slice(0, 10)}…
                    <br />
                    liquidity {p.liquidity}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="panel" style={{ marginTop: "1.25rem" }}>
        <h2>Chat with Sentinel (0G)</h2>
        <p className="empty" style={{ marginBottom: "0.75rem" }}>
          Requires <code>ZG_ROUTER_API_KEY</code> in <code>.env</code>. Use this to verify 0G Compute.
        </p>
        <div className="chat-log">
          {chatLog.length === 0 ? (
            <p className="empty">No messages yet.</p>
          ) : (
            chatLog.map((m, i) => (
              <div key={`${m.role}-${i}`} className={`chat-bubble ${m.role}`}>
                <strong>{m.role === "user" ? "you" : "sentinel"}</strong>
                <pre>{m.content}</pre>
              </div>
            ))
          )}
        </div>
        <form className="form" onSubmit={(e) => void runChat(e)}>
          <input
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Ask Sentinel something…"
          />
          <button className="primary" disabled={busy || !chatInput.trim()} type="submit">
            Send via 0G
          </button>
        </form>
      </section>

      <section className="panel" style={{ marginTop: "1.25rem" }}>
        <h2>Dry-run swap</h2>
        <form className="form" onSubmit={(e) => void runSwap(e)}>
          <input
            value={swap.tokenIn}
            onChange={(e) => setSwap({ ...swap, tokenIn: e.target.value })}
            placeholder="tokenIn"
          />
          <input
            value={swap.tokenOut}
            onChange={(e) => setSwap({ ...swap, tokenOut: e.target.value })}
            placeholder="tokenOut"
          />
          <input
            value={swap.amount}
            onChange={(e) => setSwap({ ...swap, amount: e.target.value })}
            placeholder="amount"
          />
          <button className="primary" disabled={busy} type="submit">
            Quote / swap via Uniswap API
          </button>
        </form>
      </section>

      {message ? <pre className="msg">{message}</pre> : null}
    </div>
  );
}

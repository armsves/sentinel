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
  actions: { withdrawLp: boolean; swapToStables: boolean };
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
    setBusy(true);
    setMessage("");
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
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);

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

      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => void simulatePanic()}>
          Simulate Blockaid + Glider panic
        </button>
        <button disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

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

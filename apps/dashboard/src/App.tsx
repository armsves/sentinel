import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "react-toastify";

type Page = "home" | "control" | "config" | "portfolio";

type Health = {
  ok: boolean;
  chainId: number;
  executionMode: string;
  dryRun: boolean;
  xAccounts?: string[];
  xLive?: boolean;
  watchedPools: number;
  watchedPositions?: number;
  store?: string;
  publicDemo?: boolean;
  safeWallet?: string | null;
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
  pool?: string;
  token0Address: string;
  token1Address: string;
  liquidity?: string;
  feeTier?: number;
  note?: string;
};

type PositionsPayload = {
  address: string;
  positions: Position[];
  safeWallet?: string | null;
  watchedPools?: string[];
  publicDemo?: boolean;
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

const NAV: Array<{ id: Page; label: string }> = [
  { id: "home", label: "Home" },
  { id: "control", label: "Control" },
  { id: "config", label: "Configuration" },
  { id: "portfolio", label: "Portfolio" },
];

const STABLES: Array<"USDC" | "USDT" | "DAI"> = ["USDC", "USDT", "DAI"];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  let json: { error?: string } = {};
  if (text) {
    try {
      json = JSON.parse(text) as { error?: string };
    } catch {
      throw new Error(
        text.slice(0, 180).trim() || `${res.status} ${res.statusText}`,
      );
    }
  }
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

function shortAddr(addr: string) {
  if (!addr || addr.length < 12) return addr || "unset";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [health, setHealth] = useState<Health | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [watchedPools, setWatchedPools] = useState<string[]>([]);
  const [wallet, setWallet] = useState("");
  const [safeWallet, setSafeWallet] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PolicySettings | null>(null);
  const [busy, setBusy] = useState(false);
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
  const [chatInput, setChatInput] = useState(
    "Say hi and confirm you are running on 0G Compute.",
  );
  const [chatLog, setChatLog] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);

  const refresh = useCallback(async () => {
    try {
      const [h, q, p, s] = await Promise.all([
        api<Health>("/api/health"),
        api<{ items: QueueItem[] }>("/api/queue"),
        api<PositionsPayload>("/api/positions").catch(
          (): PositionsPayload => ({ address: "", positions: [] }),
        ),
        api<{ policy: PolicySettings }>("/api/settings"),
      ]);
      setHealth(h);
      setQueue(q.items);
      setPositions(p.positions);
      setWatchedPools(p.watchedPools ?? []);
      setWallet(p.address);
      setSafeWallet(p.safeWallet ?? h.safeWallet ?? null);
      setPolicy(s.policy);
      setStopLossPct(s.policy.priceDropThresholdPct);
      setDepegBps(s.policy.depegThresholdBps);
      setTvlDropPct(s.policy.poolTvlDropThresholdPct);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
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
        ? Math.max(
            policy.priceDropThresholdPct + 5,
            Math.round(policy.priceDropThresholdPct * 1.4),
          )
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
      toast.success("Policy saved — agents will pick it up on the next tick.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
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
    const ordered = STABLES.filter((s) => next.includes(s));
    setPolicy({ ...policy, safeAssets: ordered.length ? ordered : ["USDC"] });
  }

  async function runPresentationDemo(execute: boolean) {
    setBusy(true);
    try {
      const res = await api<DemoRunResult>("/api/demo/run", {
        method: "POST",
        body: JSON.stringify({ scenario: demoScenario, execute }),
      });
      setDemoResult(res);
      toast.success(
        execute
          ? `Demo ${res.queueStatus ?? "done"} · ${res.event.id}`
          : `Incident queued ${res.event.id}`,
      );
      await refresh();
      await refreshActivity();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function triggerBot(
    kind: "stop_loss" | "depeg" | "tvl_drop" | "exploit",
  ) {
    setBusy(true);
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
      toast.success(`Triggered ${kind} → ${res.queueStatus ?? "done"}`);
      await refresh();
      await refreshActivity();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
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
        {
          role: "assistant",
          content: `${res.reply}\n\n— ${res.provider} · ${res.model}`,
        },
      ]);
    } catch (err) {
      setChatLog([
        ...nextHistory,
        {
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <button
          type="button"
          className="brand-mark"
          onClick={() => setPage("home")}
          aria-label="Sentinel home"
        >
          <img
            src="/sentinel-logo.png"
            alt=""
            className="brand-logo"
            width={28}
            height={28}
          />
          SENTINEL
        </button>
        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={page === item.id ? "nav-link active" : "nav-link"}
              onClick={() => setPage(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="cylon" aria-hidden="true">
          <span className="cylon-eye" />
        </div>
      </header>

      {page === "home" ? (
        <HomePage
          onOpenControl={() => setPage("control")}
          onOpenConfig={() => setPage("config")}
          onOpenPortfolio={() => setPage("portfolio")}
        />
      ) : null}

      {page === "control" ? (
        <ControlPage
          busy={busy}
          stopLossPct={stopLossPct}
          setStopLossPct={setStopLossPct}
          breachPct={breachPct}
          setBreachPct={setBreachPct}
          depegBps={depegBps}
          setDepegBps={setDepegBps}
          breachBps={breachBps}
          setBreachBps={setBreachBps}
          tvlDropPct={tvlDropPct}
          setTvlDropPct={setTvlDropPct}
          breachTvlPct={breachTvlPct}
          setBreachTvlPct={setBreachTvlPct}
          demoScenario={demoScenario}
          setDemoScenario={setDemoScenario}
          demoResult={demoResult}
          activity={activity}
          triggerBot={triggerBot}
          runPresentationDemo={runPresentationDemo}
          refresh={refresh}
        />
      ) : null}

      {page === "config" ? (
        <ConfigPage
          policy={policy}
          setPolicy={setPolicy}
          busy={busy}
          saveSettings={saveSettings}
          toggleStable={toggleStable}
          chatInput={chatInput}
          setChatInput={setChatInput}
          chatLog={chatLog}
          runChat={runChat}
          publicDemo={Boolean(health?.publicDemo)}
        />
      ) : null}

      {page === "portfolio" ? (
        <PortfolioPage
          wallet={wallet}
          safeWallet={safeWallet}
          positions={positions}
          watchedPools={watchedPools}
          queue={queue}
          health={health}
          policy={policy}
          publicDemo={Boolean(health?.publicDemo)}
          onRefresh={() => void refresh()}
        />
      ) : null}
    </div>
  );
}

function HomePage({
  onOpenControl,
  onOpenConfig,
  onOpenPortfolio,
}: {
  onOpenControl: () => void;
  onOpenConfig: () => void;
  onOpenPortfolio: () => void;
}) {
  return (
    <div className="home">
      <section className="hero">
        <div className="hero-row">
          <div className="hero-copy">
            <p className="hero-kicker">ETHGlobal Lisbon 2026</p>
            <h1 className="brand hero-brand">SENTINEL</h1>
            <p className="hero-lead">
              The DeFi panic button — exit Uniswap LP before the pool turns
              toxic.
            </p>
            <div className="hero-cta">
              <button type="button" className="primary" onClick={onOpenControl}>
                Open control
              </button>
              <button type="button" onClick={onOpenConfig}>
                Configure policy
              </button>
              <button type="button" onClick={onOpenPortfolio}>
                Check portfolio
              </button>
            </div>
          </div>
          <img
            src="/sentinel-logo.png"
            alt=""
            className="hero-logo"
            width={160}
            height={160}
          />
        </div>
      </section>

      <section className="pitch-slide">
        <p className="pitch-index">01 · Problem</p>
        <h2>Humans cannot watch liquidity 24/7</h2>
        <p className="prose">
          Exploits, stablecoin depegs, and pool drains move in seconds. By the
          time a Telegram alert is read, LP is already underwater — and clicking
          through a wallet UI is too slow.
        </p>
        <ul className="pitch-points">
          <li>Threat intel arrives after the damage starts</li>
          <li>Stop-loss / peg / TVL breaches need instant reaction</li>
          <li>Manual exits fail under stress and time pressure</li>
        </ul>
      </section>

      <section className="pitch-slide">
        <p className="pitch-index">02 · Solution</p>
        <h2>An always-on flight-to-safety agent</h2>
        <p className="prose">
          Sentinel watches your Uniswap positions and fused threat feeds. When
          policy thresholds trip, it withdraws LP, swaps into stables, and
          transfers to a safe wallet — no human in the loop.
        </p>
        <ul className="pitch-points">
          <li>Policy you set: stop-loss, depeg, TVL, severity</li>
          <li>Multi-source confirm before live exits</li>
          <li>Dry-run demo now; live execution with your keys locally</li>
        </ul>
      </section>

      <section className="pitch-slide">
        <p className="pitch-index">03 · How it works</p>
        <h2>Watch → score → exit</h2>
        <ol className="pitch-steps">
          <li>
            <strong>Watch</strong>
            <span>
              The Graph pool health, Blockaid/X, Glider webhooks, optional Forta
            </span>
          </li>
          <li>
            <strong>Score</strong>
            <span>0G Compute ranks severity and whether to panic</span>
          </li>
          <li>
            <strong>Exit</strong>
            <span>
              Withdraw LP → swap to USDC/USDT/DAI → transfer to safe wallet
            </span>
          </li>
        </ol>
        <p className="prose pitch-stack">
          Built on Uniswap Trading + LP APIs, The Graph, 0G Compute, Hexens
          Glider, and Blockaid/X.
        </p>
      </section>

      <section className="pitch-slide pitch-close">
        <p className="pitch-index">04 · Demo</p>
        <h2>Fire an incident on stage</h2>
        <p className="prose">
          Trigger a stop-loss, depeg, or exploit simulation and watch every
          step stream in the live agent feed.
        </p>
        <div className="hero-cta">
          <button type="button" className="primary" onClick={onOpenControl}>
            Simulate an incident
          </button>
          <button type="button" onClick={onOpenConfig}>
            Tune thresholds
          </button>
        </div>
      </section>
    </div>
  );
}

function ControlPage(props: {
  busy: boolean;
  stopLossPct: number;
  setStopLossPct: (n: number) => void;
  breachPct: number;
  setBreachPct: (n: number) => void;
  depegBps: number;
  setDepegBps: (n: number) => void;
  breachBps: number;
  setBreachBps: (n: number) => void;
  tvlDropPct: number;
  setTvlDropPct: (n: number) => void;
  breachTvlPct: number;
  setBreachTvlPct: (n: number) => void;
  demoScenario: "depeg" | "exploit" | "both";
  setDemoScenario: (s: "depeg" | "exploit" | "both") => void;
  demoResult: DemoRunResult | null;
  activity: ActivityEvent[];
  triggerBot: (kind: "stop_loss" | "depeg" | "tvl_drop" | "exploit") => void;
  runPresentationDemo: (execute: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const {
    busy,
    stopLossPct,
    setStopLossPct,
    breachPct,
    setBreachPct,
    depegBps,
    setDepegBps,
    breachBps,
    setBreachBps,
    tvlDropPct,
    setTvlDropPct,
    breachTvlPct,
    setBreachTvlPct,
    demoScenario,
    setDemoScenario,
    demoResult,
    activity,
    triggerBot,
    runPresentationDemo,
    refresh,
  } = props;

  return (
    <>
      <section className="page-head">
        <h1>Control</h1>
        <p className="tagline">
          Simulate a breach past your thresholds and watch the agent exit plan
          stream live.
        </p>
      </section>

      <section className="panel demo-panel">
        <h2>Trigger the bot</h2>
        <p className="hint">
          Set a threshold, simulate a breach past it, then fire. Steps appear in
          the live agent feed as detect → score → withdraw → swap → transfer.
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
          happen.
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
    </>
  );
}

function ConfigPage(props: {
  policy: PolicySettings | null;
  setPolicy: (p: PolicySettings) => void;
  busy: boolean;
  saveSettings: (e: FormEvent) => void;
  toggleStable: (sym: "USDC" | "USDT" | "DAI") => void;
  chatInput: string;
  setChatInput: (v: string) => void;
  chatLog: Array<{ role: "user" | "assistant"; content: string }>;
  runChat: (e: FormEvent) => void;
  publicDemo: boolean;
}) {
  const {
    policy,
    setPolicy,
    busy,
    saveSettings,
    toggleStable,
    chatInput,
    setChatInput,
    chatLog,
    runChat,
    publicDemo,
  } = props;

  return (
    <>
      <section className="page-head">
        <h1>Configuration</h1>
        <p className="tagline">
          Thresholds, exit actions, and signal sources the agents read every
          tick.
        </p>
      </section>

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
                      minPanicSeverity: e.target
                        .value as PolicySettings["minPanicSeverity"],
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
                Min pool TVL (USD)
                <input
                  type="number"
                  min={0}
                  value={policy.poolMinTvlUsd}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      poolMinTvlUsd: Number(e.target.value),
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
                      actions: {
                        ...policy.actions,
                        withdrawLp: e.target.checked,
                      },
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
                        sources: {
                          ...policy.sources,
                          [key]: e.target.checked,
                        },
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            {publicDemo ? (
              <p className="hint">
                Public demo forces <code>dry_run</code>. Live execution only
                runs on your local API with keys.
              </p>
            ) : null}

            <button className="primary" disabled={busy} type="submit">
              Save policy
            </button>
          </form>
        </section>
      ) : (
        <p className="empty">Loading settings…</p>
      )}

      <section className="panel" style={{ marginTop: "1.5rem" }}>
        <h2>Chat with Sentinel (0G)</h2>
        <p className="empty" style={{ marginBottom: "0.75rem" }}>
          Talk to the agent via 0G Compute router.
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
          <button
            className="primary"
            disabled={busy || !chatInput.trim()}
            type="submit"
          >
            Send via 0G
          </button>
        </form>
      </section>
    </>
  );
}

function PortfolioPage(props: {
  wallet: string;
  safeWallet: string | null;
  positions: Position[];
  watchedPools: string[];
  queue: QueueItem[];
  health: Health | null;
  policy: PolicySettings | null;
  publicDemo: boolean;
  onRefresh: () => void;
}) {
  const {
    wallet,
    safeWallet,
    positions,
    watchedPools,
    queue,
    health,
    policy,
    publicDemo,
    onRefresh,
  } = props;

  return (
    <>
      <section className="page-head portfolio-head">
        <div className="page-head-copy">
          <h1>Portfolio</h1>
          <p className="tagline">
            Hot wallet, safe destination, watched pools, and open Uniswap
            positions the agent can exit.
          </p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onRefresh}
          aria-label="Refresh portfolio"
          title="Refresh (also auto every 10s)"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-2.1-5.7" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
      </section>

      <div className="grid portfolio-summary">
        <section className="panel">
          <h2>Wallets</h2>
          <dl className="kv">
            <div>
              <dt>Hot wallet</dt>
              <dd>{wallet ? shortAddr(wallet) : "unset"}</dd>
            </div>
            <div>
              <dt>Safe wallet</dt>
              <dd>{safeWallet ? shortAddr(safeWallet) : "unset"}</dd>
            </div>
            <div>
              <dt>Chain</dt>
              <dd>{health?.chainId ?? "…"}</dd>
            </div>
            <div>
              <dt>Flight path</dt>
              <dd>{policy?.safeAssets.join(" → ") ?? "…"}</dd>
            </div>
          </dl>
          {publicDemo ? (
            <p className="hint" style={{ marginTop: "0.85rem" }}>
              Public demo shows configured watch targets. Live NFT positions
              require the local API with RPC + wallet.
            </p>
          ) : null}
        </section>

        <section className="panel">
          <h2>Watched pools</h2>
          {watchedPools.length === 0 ? (
            <p className="empty">
              No pools in <code>WATCHED_POOLS</code>
              {health?.watchedPools
                ? ` (health reports ${health.watchedPools}).`
                : "."}
            </p>
          ) : (
            <ul className="list">
              {watchedPools.map((pool) => (
                <li key={pool} className="item">
                  <div>Uniswap v3 pool</div>
                  <div className="meta mono">{pool}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid" style={{ marginTop: "1.25rem" }}>
        <section className="panel">
          <h2>Uniswap positions</h2>
          {positions.length === 0 ? (
            <p className="empty">
              No v3 positions found
              {publicDemo ? " on this public demo endpoint" : " (or RPC/wallet unset)"}
              .
            </p>
          ) : (
            <ul className="list">
              {positions.map((p) => (
                <li
                  key={
                    p.nftTokenId ??
                    p.pool ??
                    `${p.token0Address}-${p.liquidity}`
                  }
                  className="item"
                >
                  <div>
                    {p.protocol}
                    {p.nftTokenId ? ` NFT #${p.nftTokenId}` : ""}
                    {p.feeTier != null ? ` · fee ${p.feeTier}` : ""}
                  </div>
                  <div className="meta">
                    {p.pool ? (
                      <>
                        pool {shortAddr(p.pool)}
                        <br />
                      </>
                    ) : null}
                    {p.token0Address
                      ? `${shortAddr(p.token0Address)} / ${shortAddr(p.token1Address)}`
                      : null}
                    {p.liquidity ? (
                      <>
                        <br />
                        liquidity {p.liquidity}
                      </>
                    ) : null}
                    {p.note ? (
                      <>
                        <br />
                        {p.note}
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Panic queue</h2>
          {queue.length === 0 ? (
            <p className="empty">No panic events queued.</p>
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
      </div>
    </>
  );
}

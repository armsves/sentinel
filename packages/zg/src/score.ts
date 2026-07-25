import { getConfig, logger, type NormalizedSignal, type Severity } from "@sentinel/core";

export type ZgScore = {
  score: number;
  shouldPanic: boolean;
  severity: Severity;
  rationale: string;
  whichSourcesMatter: string[];
  provider: "0g-router" | "heuristic-fallback";
};

const SYSTEM = `You are Sentinel risk brain for a DeFi panic-button agent.
Return ONLY valid JSON with keys:
score (0-1), shouldPanic (boolean), severity (low|medium|high|critical),
rationale (short string), whichSourcesMatter (string array).
Prefer precision over recall when evidence is weak.
Critical only for clear live exploits, depegs, or sharp pool drains.`;

function heuristicScore(signals: NormalizedSignal[]): ZgScore {
  const sources = [...new Set(signals.map((s) => s.source))];
  const max = signals.reduce(
    (acc, s) =>
      ({ low: 1, medium: 2, high: 3, critical: 4 }[s.severity] >
      { low: 1, medium: 2, high: 3, critical: 4 }[acc]
        ? s.severity
        : acc),
    "low" as Severity,
  );
  const score =
    max === "critical" ? 0.92 : max === "high" ? 0.75 : max === "medium" ? 0.45 : 0.2;
  return {
    score,
    shouldPanic: max === "critical" || (max === "high" && sources.length >= 2),
    severity: max,
    rationale: `Heuristic fallback from ${signals.length} signal(s): ${sources.join(", ")}`,
    whichSourcesMatter: sources,
    provider: "heuristic-fallback",
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON object in model response");
    return JSON.parse(m[0]);
  }
}

export async function scoreSignalsWith0G(
  signals: NormalizedSignal[],
): Promise<ZgScore> {
  if (!signals.length) {
    return {
      score: 0,
      shouldPanic: false,
      severity: "low",
      rationale: "no signals",
      whichSourcesMatter: [],
      provider: "heuristic-fallback",
    };
  }

  const cfg = getConfig();
  if (
    !cfg.ZG_SCORING_ENABLED ||
    cfg.ZG_COMPUTE_MODE === "off" ||
    !cfg.ZG_ROUTER_API_KEY
  ) {
    logger.info("0G scoring skipped — using heuristic", {
      enabled: cfg.ZG_SCORING_ENABLED,
      hasKey: Boolean(cfg.ZG_ROUTER_API_KEY),
    });
    return heuristicScore(signals);
  }

  const compact = signals.slice(0, 20).map((s) => ({
    source: s.source,
    severity: s.severity,
    category: s.category,
    message: s.message.slice(0, 280),
    addresses: s.addresses.slice(0, 5),
    tokens: s.tokens?.slice(0, 8),
  }));

  try {
    const res = await fetch(`${cfg.ZG_ROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.ZG_ROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: cfg.ZG_MODEL,
        temperature: 0.1,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: JSON.stringify({
              thresholds: {
                panicConfirmations: cfg.PANIC_CONFIRMATIONS,
                priceDropPct: cfg.PRICE_DROP_THRESHOLD_PCT,
                depegBps: cfg.DEPEG_THRESHOLD_BPS,
              },
              signals: compact,
            }),
          },
        ],
      }),
    });
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: unknown;
    };
    if (!res.ok) {
      throw new Error(`0G router ${res.status}: ${JSON.stringify(json.error ?? json)}`);
    }
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(content) as Partial<ZgScore>;
    const score = Math.min(1, Math.max(0, Number(parsed.score ?? 0)));
    const severity = (["low", "medium", "high", "critical"].includes(
      String(parsed.severity),
    )
      ? parsed.severity
      : heuristicScore(signals).severity) as Severity;
    return {
      score,
      shouldPanic: Boolean(parsed.shouldPanic),
      severity,
      rationale: String(parsed.rationale ?? "0G scored signals"),
      whichSourcesMatter: Array.isArray(parsed.whichSourcesMatter)
        ? parsed.whichSourcesMatter.map(String)
        : [...new Set(signals.map((s) => s.source))],
      provider: "0g-router",
    };
  } catch (err) {
    logger.warn("0G scoring failed — heuristic fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
    return heuristicScore(signals);
  }
}

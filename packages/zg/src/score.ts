import { getConfig, logger, type NormalizedSignal, type Severity } from "@sentinel/core";

export type ZgScore = {
  score: number;
  shouldPanic: boolean;
  severity: Severity;
  rationale: string;
  whichSourcesMatter: string[];
  provider: "0g-router" | "0g-skipped";
};

const SYSTEM = `You are Sentinel risk brain for a DeFi panic-button agent.
Return ONLY valid JSON with keys:
score (0-1), shouldPanic (boolean), severity (low|medium|high|critical),
rationale (short string), whichSourcesMatter (string array).
Prefer precision over recall when evidence is weak.
Critical only for clear live exploits, depegs, or sharp pool drains.`;

const skipped = (
  rationale: string,
  whichSourcesMatter: string[] = [],
): ZgScore => ({
  score: 0,
  shouldPanic: false,
  severity: "low",
  rationale,
  whichSourcesMatter,
  provider: "0g-skipped",
});

let lastCallAt = 0;
let backoffUntil = 0;
let consecutiveRateLimits = 0;

function maxSeverity(signals: NormalizedSignal[]): Severity {
  return signals.reduce(
    (acc, s) =>
      ({ low: 1, medium: 2, high: 3, critical: 4 }[s.severity] >
      { low: 1, medium: 2, high: 3, critical: 4 }[acc]
        ? s.severity
        : acc),
    "low" as Severity,
  );
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

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

export async function scoreSignalsWith0G(
  signals: NormalizedSignal[],
  opts?: { force?: boolean },
): Promise<ZgScore> {
  if (!signals.length) {
    return skipped("no signals");
  }

  const cfg = getConfig();
  const sources = [...new Set(signals.map((s) => s.source))];

  if (
    !cfg.ZG_SCORING_ENABLED ||
    cfg.ZG_COMPUTE_MODE === "off" ||
    !cfg.ZG_ROUTER_API_KEY
  ) {
    logger.info("0G scoring skipped", {
      enabled: cfg.ZG_SCORING_ENABLED,
      hasKey: Boolean(cfg.ZG_ROUTER_API_KEY),
    });
    return skipped("0G scoring disabled or missing API key", sources);
  }

  const now = Date.now();
  const minInterval = Math.max(0, cfg.ZG_MIN_INTERVAL_MS);

  if (!opts?.force) {
    if (now < backoffUntil) {
      const waitMs = backoffUntil - now;
      logger.warn("0G scoring skipped — rate-limit backoff", { waitMs });
      return skipped(`0G rate-limited; retry in ${Math.ceil(waitMs / 1000)}s`, sources);
    }
    if (lastCallAt > 0 && now - lastCallAt < minInterval) {
      const waitMs = minInterval - (now - lastCallAt);
      logger.info("0G scoring skipped — min interval", {
        waitMs,
        minIntervalMs: minInterval,
      });
      return skipped(
        `0G throttled; next call in ${Math.ceil(waitMs / 1000)}s`,
        sources,
      );
    }
  }

  const compact = signals.slice(0, 20).map((s) => ({
    source: s.source,
    severity: s.severity,
    category: s.category,
    message: s.message.slice(0, 280),
    addresses: s.addresses.slice(0, 5),
    tokens: s.tokens?.slice(0, 8),
  }));

  lastCallAt = now;

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

    if (res.status === 429) {
      consecutiveRateLimits += 1;
      const retryMs =
        parseRetryAfterMs(res) ??
        Math.min(10 * 60_000, 60_000 * 2 ** Math.min(consecutiveRateLimits - 1, 3));
      backoffUntil = Date.now() + retryMs;
      const body = await res.text().catch(() => "");
      logger.warn("0G scoring rate-limited — backing off", {
        retryMs,
        consecutiveRateLimits,
        body: body.slice(0, 200),
      });
      return skipped(
        `0G rate-limited; backoff ${Math.ceil(retryMs / 1000)}s`,
        sources,
      );
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: unknown;
    };
    if (!res.ok) {
      throw new Error(`0G router ${res.status}: ${JSON.stringify(json.error ?? json)}`);
    }

    consecutiveRateLimits = 0;
    backoffUntil = 0;

    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(content) as Partial<ZgScore>;
    const score = Math.min(1, Math.max(0, Number(parsed.score ?? 0)));
    const severity = (["low", "medium", "high", "critical"].includes(
      String(parsed.severity),
    )
      ? parsed.severity
      : maxSeverity(signals)) as Severity;
    return {
      score,
      shouldPanic: Boolean(parsed.shouldPanic),
      severity,
      rationale: String(parsed.rationale ?? "0G scored signals"),
      whichSourcesMatter: Array.isArray(parsed.whichSourcesMatter)
        ? parsed.whichSourcesMatter.map(String)
        : sources,
      provider: "0g-router",
    };
  } catch (err) {
    logger.warn("0G scoring failed — skipping (no heuristic)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return skipped(
      `0G unavailable: ${err instanceof Error ? err.message : String(err)}`,
      sources,
    );
  }
}

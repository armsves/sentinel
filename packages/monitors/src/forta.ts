import { getConfig, logger, type NormalizedSignal } from "@sentinel/core";

type FortaAlert = {
  hash?: string;
  name?: string;
  description?: string;
  protocol?: string;
  severity?: number | string;
  addresses?: string[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

function mapFortaSeverity(sev: number | string | undefined): NormalizedSignal["severity"] {
  const n = typeof sev === "string" ? Number(sev) : sev;
  if (n === undefined || Number.isNaN(n)) return "medium";
  if (n >= 4) return "critical";
  if (n >= 3) return "high";
  if (n >= 2) return "medium";
  return "low";
}

/**
 * Lightweight Forta GraphQL poll for recent CRITICAL/HIGH alerts.
 * Disabled unless FORTA_POLL_ENABLED=true.
 * Docs: https://docs.forta.network/
 */
export async function pollFortaAlerts(): Promise<NormalizedSignal[]> {
  const cfg = getConfig();
  if (!cfg.FORTA_POLL_ENABLED) return [];

  const query = `
    query RecentAlerts {
      alerts(input: {
        first: 10
        severities: ["CRITICAL", "HIGH"]
      }) {
        alerts {
          hash
          name
          description
          protocol
          severity
          addresses
          createdAt
        }
      }
    }
  `;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.FORTA_API_KEY) headers.Authorization = `Bearer ${cfg.FORTA_API_KEY}`;

  try {
    const res = await fetch(cfg.FORTA_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });
    const json = (await res.json()) as {
      data?: { alerts?: { alerts?: FortaAlert[] } };
      errors?: unknown;
    };
    if (!res.ok || json.errors) {
      throw new Error(JSON.stringify(json.errors ?? { status: res.status }));
    }
    const alerts = json.data?.alerts?.alerts ?? [];
    logger.info("forta poll", { count: alerts.length });
    return alerts.map((a) => ({
      source: "forta" as const,
      severity: mapFortaSeverity(a.severity),
      addresses: (a.addresses ?? []).map((x) => x.toLowerCase()),
      category: "exploit" as const,
      message: `[forta] ${a.name ?? "alert"}: ${(a.description ?? "").slice(0, 220)}`,
      raw: a,
      ts: a.createdAt ? Date.parse(a.createdAt) || Date.now() : Date.now(),
    }));
  } catch (err) {
    logger.error("forta poll failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

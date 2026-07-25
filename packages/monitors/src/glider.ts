import type { NormalizedSignal, Severity } from "@sentinel/core";

/**
 * Hexens Glider Monitor webhook payloads vary by alert type.
 * We accept a flexible shape and normalize into NormalizedSignal.
 * Docs: https://hexens.io/solutions/glider-monitor
 */
export type GliderWebhookPayload = {
  id?: string;
  alertId?: string;
  type?: string;
  category?: string;
  severity?: string;
  title?: string;
  message?: string;
  description?: string;
  contractAddress?: string;
  address?: string;
  addresses?: string[];
  txHash?: string;
  chainId?: number | string;
  timestamp?: string | number;
  raw?: unknown;
  [key: string]: unknown;
};

function mapSeverity(raw?: string): Severity {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("crit") || s === "p0" || s === "1") return "critical";
  if (s.includes("high") || s === "p1" || s === "2") return "high";
  if (s.includes("med") || s === "p2" || s === "3") return "medium";
  if (s.includes("low") || s === "p3") return "low";
  // default Glider live-attack style alerts to high
  return "high";
}

function mapCategory(
  payload: GliderWebhookPayload,
): NormalizedSignal["category"] {
  const blob = `${payload.type ?? ""} ${payload.category ?? ""} ${payload.title ?? ""} ${payload.message ?? ""}`.toLowerCase();
  if (blob.includes("depeg") || blob.includes("oracle")) return "depeg";
  if (blob.includes("invariant")) return "invariant";
  if (blob.includes("dependenc")) return "dependency";
  if (blob.includes("exploit") || blob.includes("attack")) return "exploit";
  if (blob.includes("hack")) return "hack";
  return "other";
}

function collectAddresses(payload: GliderWebhookPayload): string[] {
  const out = new Set<string>();
  const push = (v?: string) => {
    if (v && /^0x[a-fA-F0-9]{40}$/.test(v)) out.add(v.toLowerCase());
  };
  push(payload.contractAddress);
  push(payload.address);
  for (const a of payload.addresses ?? []) push(a);
  const text = `${payload.title ?? ""} ${payload.message ?? ""} ${payload.description ?? ""}`;
  for (const m of text.match(/0x[a-fA-F0-9]{40}/g) ?? []) {
    out.add(m.toLowerCase());
  }
  return [...out];
}

export function normalizeGliderWebhook(
  payload: GliderWebhookPayload,
): NormalizedSignal {
  const message =
    payload.message ||
    payload.description ||
    payload.title ||
    `Glider alert ${payload.type ?? payload.category ?? "unknown"}`;

  const ts =
    typeof payload.timestamp === "number"
      ? payload.timestamp
      : payload.timestamp
        ? Date.parse(String(payload.timestamp)) || Date.now()
        : Date.now();

  return {
    source: "glider",
    severity: mapSeverity(payload.severity),
    addresses: collectAddresses(payload),
    category: mapCategory(payload),
    message: `[glider] ${message}`.slice(0, 500),
    raw: payload,
    ts,
  };
}

/** Demo fixture for local testing without Hexens portal */
export const GLIDER_FIXTURE: GliderWebhookPayload = {
  id: "fixture-glider-1",
  type: "live_exploitation",
  category: "react",
  severity: "critical",
  title: "Live attacking transaction against watched protocol",
  message:
    "Glider detected a live exploitation path against contract 0x71518580f36feceffe0721f06ba4703218cd7f63 (bridge dependency). Recommend immediate position exit.",
  contractAddress: "0x71518580f36feceffe0721f06ba4703218cd7f63",
  txHash: "0xa1f1e65c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  chainId: 1,
  timestamp: Date.now(),
};

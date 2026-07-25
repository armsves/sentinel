import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "./config.js";
import { loadPolicySettings, severityRank } from "./settings.js";
import type { NormalizedSignal, PanicEvent, Severity } from "./types.js";

export type QueueItem = {
  event: PanicEvent;
  status: "pending" | "processing" | "done" | "failed";
  enqueuedAt: number;
  updatedAt: number;
  error?: string;
};

function queuePath(): string {
  return resolve(process.cwd(), process.env.PANIC_QUEUE_PATH ?? "data/panic-queue.json");
}

async function loadQueue(): Promise<QueueItem[]> {
  const path = queuePath();
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as QueueItem[];
  } catch {
    return [];
  }
}

async function saveQueue(items: QueueItem[]): Promise<void> {
  const path = queuePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(items, null, 2));
  await rename(tmp, path);
}

export async function buildPanicEvent(
  signals: NormalizedSignal[],
  opts?: {
    positions?: PanicEvent["positions"];
    zgScore?: number;
    zgRationale?: string;
    zgShouldPanic?: boolean;
  },
): Promise<PanicEvent | null> {
  if (!signals.length) return null;
  const cfg = getConfig();
  const policy = await loadPolicySettings();
  const sources = new Set(signals.map((s) => s.source));
  const maxSev = signals.reduce<Severity>(
    (acc, s) => (severityRank(s.severity) > severityRank(acc) ? s.severity : acc),
    "low",
  );

  if (severityRank(maxSev) < severityRank(policy.minPanicSeverity)) {
    return null;
  }

  const zgBoost =
    opts?.zgShouldPanic === true &&
    (opts.zgScore ?? 0) >= 0.8 &&
    signals.length >= 1 &&
    policy.sources.zg;

  const needed = policy.panicConfirmations || cfg.PANIC_CONFIRMATIONS;
  const confirmed =
    sources.size >= needed ||
    (maxSev === "critical" && sources.has("x")) ||
    (maxSev === "critical" && sources.has("glider")) ||
    zgBoost;

  const mode = policy.executionMode || cfg.EXECUTION_MODE;
  if (!confirmed && maxSev !== "critical") return null;
  if (!confirmed && needed > 1 && maxSev === "critical" && sources.size === 1) {
    if (mode !== "dry_run") return null;
  }

  const id = createHash("sha256")
    .update(
      signals
        .map((s) => `${s.source}:${s.message}`)
        .sort()
        .join("|"),
    )
    .digest("hex")
    .slice(0, 16);

  return {
    id: `${id}-${randomUUID().slice(0, 8)}`,
    ts: Date.now(),
    severity: opts?.zgScore && opts.zgScore >= 0.9 ? "critical" : maxSev,
    reasons: signals.map((s) => ({
      source: s.source,
      signal: s.message,
      evidence: {
        addresses: s.addresses,
        tokens: s.tokens,
        category: s.category,
        raw: s.raw,
      },
    })),
    positions: opts?.positions ?? [],
    targetStables: policy.safeAssets,
    mode,
    zgScore: opts?.zgScore,
    zgRationale: opts?.zgRationale,
  };
}

export async function enqueuePanic(event: PanicEvent): Promise<boolean> {
  const items = await loadQueue();
  const fingerprint = event.id.split("-")[0];
  const recent = items.find(
    (i) =>
      i.event.id.startsWith(fingerprint ?? "") &&
      Date.now() - i.enqueuedAt < 15 * 60_000,
  );
  if (recent) return false;
  items.push({
    event,
    status: "pending",
    enqueuedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await saveQueue(items);
  await appendFile(
    resolve(dirname(queuePath()), "panic-events.jsonl"),
    `${JSON.stringify(event)}\n`,
  ).catch(() => undefined);
  return true;
}

export async function dequeuePending(): Promise<QueueItem | null> {
  const items = await loadQueue();
  const idx = items.findIndex((i) => i.status === "pending");
  if (idx === -1) return null;
  const item = items[idx]!;
  item.status = "processing";
  item.updatedAt = Date.now();
  await saveQueue(items);
  return item;
}

export async function completeItem(
  id: string,
  status: "done" | "failed",
  error?: string,
): Promise<void> {
  const items = await loadQueue();
  const item = items.find((i) => i.event.id === id);
  if (!item) return;
  item.status = status;
  item.updatedAt = Date.now();
  if (error) item.error = error;
  await saveQueue(items);
}

export async function listQueue(): Promise<QueueItem[]> {
  return loadQueue();
}

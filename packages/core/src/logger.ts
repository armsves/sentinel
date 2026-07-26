type Level = "debug" | "info" | "warn" | "error";

export type LogSignal = {
  source: string;
  severity: string;
  category?: string;
  message: string;
};

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  brightRed: "\x1b[91m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
  brightMagenta: "\x1b[95m",
  brightGreen: "\x1b[92m",
} as const;

const LEVEL_STYLE: Record<Level, { label: string; color: string }> = {
  debug: { label: "DEBUG", color: ansi.gray },
  info: { label: "INFO ", color: ansi.cyan },
  warn: { label: "WARN ", color: ansi.yellow },
  error: { label: "ERROR", color: ansi.red },
};

const SOURCE_COLOR: Record<string, string> = {
  x: ansi.brightMagenta,
  graph: ansi.brightCyan,
  price: ansi.brightYellow,
  glider: ansi.brightRed,
  forta: ansi.blue,
  zg: ansi.brightGreen,
  uniswap: ansi.green,
  defimon: ansi.magenta,
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: ansi.brightRed + ansi.bold,
  high: ansi.red,
  medium: ansi.yellow,
  low: ansi.gray,
};

const CATEGORY_COLOR: Record<string, string> = {
  exploit: ansi.brightRed,
  hack: ansi.brightRed,
  depeg: ansi.brightYellow,
  price: ansi.yellow,
  pool_health: ansi.cyan,
  dependency: ansi.magenta,
  invariant: ansi.blue,
  other: ansi.gray,
};

function useColor(): boolean {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

function useJson(): boolean {
  const fmt = (process.env.LOG_FORMAT ?? "").toLowerCase();
  if (fmt === "json") return true;
  if (fmt === "pretty") return false;
  return !process.stdout.isTTY;
}

function minLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function paint(color: string, text: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${color}${text}${ansi.reset}`;
}

function formatExtra(extra: unknown, color: boolean): string {
  if (extra === undefined) return "";
  let body: string;
  try {
    body =
      typeof extra === "string"
        ? extra
        : JSON.stringify(extra, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
          );
  } catch {
    body = String(extra);
  }
  return ` ${paint(ansi.dim, body, color)}`;
}

function formatPretty(level: Level, msg: string, extra?: unknown): string {
  const color = useColor();
  const style = LEVEL_STYLE[level];
  const ts = new Date().toISOString().slice(11, 23);
  const time = paint(ansi.dim, ts, color);
  const tag = paint(style.color + ansi.bold, style.label, color);
  const message =
    level === "error"
      ? paint(ansi.red, msg, color)
      : level === "warn"
        ? paint(ansi.yellow, msg, color)
        : paint(ansi.white, msg, color);
  return `${time} ${tag} ${message}${formatExtra(extra, color)}`;
}

function formatSignalLine(signal: LogSignal): string {
  const color = useColor();
  const ts = new Date().toISOString().slice(11, 23);
  const time = paint(ansi.dim, ts, color);
  const srcKey = signal.source.toLowerCase();
  const sevKey = signal.severity.toLowerCase();
  const catKey = (signal.category ?? "other").toLowerCase();

  const source = paint(
    SOURCE_COLOR[srcKey] ?? ansi.white,
    signal.source.padEnd(7),
    color,
  );
  const severity = paint(
    SEVERITY_COLOR[sevKey] ?? ansi.white,
    signal.severity.padEnd(8),
    color,
  );
  const category = paint(
    CATEGORY_COLOR[catKey] ?? ansi.gray,
    (signal.category ?? "other").padEnd(11),
    color,
  );
  const bullet = paint(SEVERITY_COLOR[sevKey] ?? ansi.white, "●", color);
  const msg = paint(
    sevKey === "critical" || sevKey === "high" ? ansi.white + ansi.bold : ansi.white,
    signal.message,
    color,
  );

  return `${time} ${bullet} ${source} ${severity} ${category} ${msg}`;
}

function write(level: Level, text: string) {
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

function log(level: Level, msg: string, extra?: unknown) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel()]) return;

  if (useJson()) {
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(extra !== undefined ? { extra } : {}),
    };
    write(level, JSON.stringify(line));
    return;
  }

  write(level, formatPretty(level, msg, extra));
}

function logSignals(
  summary: string,
  signals: LogSignal[],
  level: Level = "warn",
) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel()]) return;

  if (useJson()) {
    log(level, summary, {
      count: signals.length,
      signals: signals.map((s) => ({
        source: s.source,
        severity: s.severity,
        category: s.category,
        message: s.message,
      })),
    });
    return;
  }

  write(level, formatPretty(level, summary, { count: signals.length }));
  for (const signal of signals) {
    write(level, formatSignalLine(signal));
  }
}

export const logger = {
  debug: (msg: string, extra?: unknown) => log("debug", msg, extra),
  info: (msg: string, extra?: unknown) => log("info", msg, extra),
  warn: (msg: string, extra?: unknown) => log("warn", msg, extra),
  error: (msg: string, extra?: unknown) => log("error", msg, extra),
  /** One colored line per threat / X / price / pool signal. */
  signals: (summary: string, signals: LogSignal[], level: Level = "warn") =>
    logSignals(summary, signals, level),
};

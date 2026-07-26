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
  underline: "\x1b[4m",
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
  brightWhite: "\x1b[97m",
  brightBlue: "\x1b[94m",
} as const;

const LEVEL_STYLE: Record<Level, { label: string; color: string }> = {
  debug: { label: "DEBUG", color: ansi.gray },
  info: { label: "INFO ", color: ansi.brightCyan },
  warn: { label: "WARN ", color: ansi.brightYellow },
  error: { label: "ERROR", color: ansi.brightRed },
};

const SOURCE_COLOR: Record<string, string> = {
  x: ansi.brightMagenta,
  graph: ansi.brightCyan,
  price: ansi.brightYellow,
  glider: ansi.brightRed,
  forta: ansi.brightBlue,
  zg: ansi.brightGreen,
  uniswap: ansi.green,
  defimon: ansi.magenta,
  scanner: ansi.brightCyan,
  executor: ansi.brightGreen,
  api: ansi.blue,
  demo: ansi.brightMagenta,
  system: ansi.gray,
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: ansi.brightRed + ansi.bold,
  high: ansi.brightRed,
  medium: ansi.brightYellow,
  low: ansi.gray,
};

const CATEGORY_COLOR: Record<string, string> = {
  exploit: ansi.brightRed + ansi.bold,
  hack: ansi.brightRed + ansi.bold,
  depeg: ansi.brightYellow + ansi.bold,
  price: ansi.brightYellow,
  pool_health: ansi.brightCyan,
  dependency: ansi.brightMagenta,
  invariant: ansi.brightBlue,
  other: ansi.gray,
};

const PHASE_COLOR: Record<string, string> = {
  detect: ansi.brightYellow,
  score: ansi.brightMagenta,
  enqueue: ansi.brightRed,
  withdraw: ansi.brightCyan,
  swap: ansi.brightGreen,
  transfer: ansi.green,
  heartbeat: ansi.gray,
  error: ansi.brightRed,
  done: ansi.brightGreen,
  policy: ansi.blue,
  trigger: ansi.brightYellow,
};

function useColor(): boolean {
  if (process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") return false;
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

/** Colorize free-form risk / activity message text. */
function colorizeText(text: string, enabled: boolean): string {
  if (!enabled) return text;

  // Protect already-colored spans by working on plain text only.
  let out = text;

  const replaceAll = (re: RegExp, color: string) => {
    out = out.replace(re, (m) => paint(color, m, true));
  };

  // Activity prefix [agent/phase]
  out = out.replace(/^\[([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\]/, (_m, agent, phase) => {
    const a = paint(SOURCE_COLOR[String(agent).toLowerCase()] ?? ansi.cyan, String(agent), true);
    const p = paint(PHASE_COLOR[String(phase).toLowerCase()] ?? ansi.yellow, String(phase), true);
    return `${paint(ansi.dim, "[", true)}${a}${paint(ansi.dim, "/", true)}${p}${paint(ansi.dim, "]", true)}`;
  });

  // Token pairs USDC/sUSD, WETH/USDC, …
  replaceAll(
    /\b[A-Za-z][A-Za-z0-9]{1,11}\/[A-Za-z][A-Za-z0-9]{1,11}\b/g,
    ansi.brightCyan + ansi.bold,
  );

  // @handles
  replaceAll(/@[A-Za-z0-9_]{2,}/g, ansi.brightMagenta + ansi.bold);

  // Hex addresses / ids
  replaceAll(/\b0x[a-fA-F0-9]{6,}\b/g, ansi.brightBlue);

  // NFT #ids
  replaceAll(/\bNFT\s*#\d+\b/gi, ansi.brightCyan + ansi.bold);

  // Percents and bps
  replaceAll(/-?\d+(?:\.\d+)?%/g, ansi.brightYellow + ansi.bold);
  replaceAll(/\b\d+(?:\.\d+)?\s*bps\b/gi, ansi.brightYellow + ansi.bold);

  // Money-ish
  replaceAll(/\$\d+(?:\.\d+)?/g, ansi.brightGreen + ansi.bold);

  // Hot keywords
  out = out.replace(
    /\b(unhealthy|depeg|stop-loss|exploit|hack|panic|critical|failed|error|dry_run|LIVE)\b/gi,
    (m) => {
      const lower = m.toLowerCase();
      if (
        lower === "failed" ||
        lower === "error" ||
        lower === "critical" ||
        lower === "exploit" ||
        lower === "hack" ||
        lower === "panic"
      ) {
        return paint(ansi.brightRed + ansi.bold, m, true);
      }
      if (lower === "live") {
        return paint(ansi.brightRed + ansi.bold + ansi.underline, m, true);
      }
      if (lower === "dry_run") return paint(ansi.brightGreen, m, true);
      if (
        lower === "depeg" ||
        lower === "stop-loss" ||
        lower === "unhealthy"
      ) {
        return paint(ansi.brightYellow + ansi.bold, m, true);
      }
      return paint(ansi.brightYellow, m, true);
    },
  );

  return out;
}

function colorizeJson(value: unknown, enabled: boolean, indent = 0): string {
  if (!enabled) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  if (value === null) return paint(ansi.gray, "null", true);
  if (typeof value === "boolean") {
    return paint(value ? ansi.brightGreen : ansi.brightRed, String(value), true);
  }
  if (typeof value === "number") {
    return paint(ansi.brightYellow, String(value), true);
  }
  if (typeof value === "bigint") {
    return paint(ansi.brightYellow, value.toString(), true);
  }
  if (typeof value === "string") {
    const colored = colorizeText(value, true);
    // If colorize already painted, wrap quotes in green dim
    return `${paint(ansi.green, '"', true)}${colored}${paint(ansi.green, '"', true)}`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return paint(ansi.dim, "[]", true);
    if (value.length <= 4 && value.every((v) => typeof v !== "object" || v === null)) {
      return `${paint(ansi.dim, "[", true)}${value
        .map((v) => colorizeJson(v, true))
        .join(paint(ansi.dim, ", ", true))}${paint(ansi.dim, "]", true)}`;
    }
    const pad = "  ".repeat(indent + 1);
    const close = "  ".repeat(indent);
    const body = value
      .map((v) => `${pad}${colorizeJson(v, true, indent + 1)}`)
      .join(`${paint(ansi.dim, ",", true)}\n`);
    return `${paint(ansi.dim, "[", true)}\n${body}\n${close}${paint(ansi.dim, "]", true)}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return paint(ansi.dim, "{}", true);
    const compact =
      entries.length <= 5 &&
      entries.every(
        ([, v]) =>
          v === null ||
          ["string", "number", "boolean"].includes(typeof v) ||
          (Array.isArray(v) && v.length <= 3),
      );
    if (compact) {
      const inner = entries
        .map(([k, v]) => {
          const key = paint(ansi.brightCyan, `"${k}"`, true);
          return `${key}${paint(ansi.dim, ":", true)} ${colorizeJson(v, true)}`;
        })
        .join(paint(ansi.dim, ", ", true));
      return `${paint(ansi.dim, "{", true)}${inner}${paint(ansi.dim, "}", true)}`;
    }
    const pad = "  ".repeat(indent + 1);
    const close = "  ".repeat(indent);
    const body = entries
      .map(([k, v]) => {
        const key = paint(ansi.brightCyan, `"${k}"`, true);
        return `${pad}${key}${paint(ansi.dim, ":", true)} ${colorizeJson(v, true, indent + 1)}`;
      })
      .join(`${paint(ansi.dim, ",", true)}\n`);
    return `${paint(ansi.dim, "{", true)}\n${body}\n${close}${paint(ansi.dim, "}", true)}`;
  }
  return paint(ansi.white, String(value), true);
}

function formatExtra(extra: unknown, color: boolean): string {
  if (extra === undefined) return "";
  if (typeof extra === "string") {
    return ` ${colorizeText(extra, color)}`;
  }
  try {
    return ` ${colorizeJson(extra, color)}`;
  } catch {
    return ` ${paint(ansi.dim, String(extra), color)}`;
  }
}

function formatPretty(level: Level, msg: string, extra?: unknown): string {
  const color = useColor();
  const style = LEVEL_STYLE[level];
  const ts = new Date().toISOString().slice(11, 23);
  const time = paint(ansi.dim + ansi.gray, ts, color);
  const tag = paint(style.color + ansi.bold, style.label, color);
  const messageBase = colorizeText(msg, color);
  return `${time} ${tag} ${messageBase}${formatExtra(extra, color)}`;
}

function formatSignalLine(signal: LogSignal): string {
  const color = useColor();
  const ts = new Date().toISOString().slice(11, 23);
  const time = paint(ansi.dim + ansi.gray, ts, color);
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
  const msg = colorizeText(signal.message, color);

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

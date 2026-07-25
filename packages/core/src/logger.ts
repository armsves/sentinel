type Level = "debug" | "info" | "warn" | "error";

function log(level: Level, msg: string, extra?: unknown) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra !== undefined ? { extra } : {}),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (msg: string, extra?: unknown) => log("debug", msg, extra),
  info: (msg: string, extra?: unknown) => log("info", msg, extra),
  warn: (msg: string, extra?: unknown) => log("warn", msg, extra),
  error: (msg: string, extra?: unknown) => log("error", msg, extra),
};

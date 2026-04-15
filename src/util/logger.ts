type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const current: Level = (process.env.CTGOV_LOG_LEVEL as Level) ?? "info";

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[current]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(data ?? {}),
  };
  // MCP stdio uses stdout for protocol; all logs must go to stderr.
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => emit("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
};

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(format: "json" | "pretty"): Logger {
  const write = (
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown> = {},
  ) => {
    const safe = redact(fields) as Record<string, unknown>;
    console.log(
      format === "json"
        ? JSON.stringify({ time: new Date().toISOString(), level, event, ...safe })
        : `${level.toUpperCase()} ${event} ${JSON.stringify(safe)}`,
    );
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = /secret|token|authorization|cookie|proof|private|key/i.test(key)
      ? "[REDACTED]"
      : redact(item);
  }
  return output;
}

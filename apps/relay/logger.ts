export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(format: "json" | "pretty"): Logger {
  function write(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    const safeFields = redact(fields) as Record<string, unknown>;
    if (format === "json") {
      console.log(JSON.stringify({
        time: new Date().toISOString(),
        level,
        event,
        ...safeFields,
      }));
    } else {
      console.log(`${level.toUpperCase()} ${event}`, safeFields);
    }
  }
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
    output[key] = /secret|token|authorization|cookie|proof|key/i.test(key)
      ? "[REDACTED]"
      : redact(item);
  }
  return output;
}

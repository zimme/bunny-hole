import { loadRelayConfig, redactedConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { Relay } from "./relay.ts";

export const VERSION = "0.1.0";

if (import.meta.main) {
  if (Deno.args[0] === "--healthcheck") {
    try {
      const port = Deno.env.get("PORT") ?? "8080";
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      Deno.exit(response.ok ? 0 : 1);
    } catch {
      Deno.exit(1);
    }
  }
  try {
    const config = loadRelayConfig();
    const logger = createLogger(config.logFormat);
    const relay = new Relay(config, logger);
    logger.info("relay_starting", { version: VERSION, config: redactedConfig(config) });
    const abort = new AbortController();
    const server = Deno.serve(
      {
        hostname: config.hostname,
        port: config.port,
        signal: abort.signal,
        onListen: ({ hostname, port }) =>
          logger.info("relay_listening", { hostname, port }),
      },
      (request, info) => relay.handle(request, info),
    );
    const shutdown = () => {
      relay.shutdown();
      setTimeout(() => abort.abort(), 250);
    };
    Deno.addSignalListener("SIGTERM", shutdown);
    Deno.addSignalListener("SIGINT", shutdown);
    try {
      await server.finished;
    } finally {
      Deno.removeSignalListener("SIGTERM", shutdown);
      Deno.removeSignalListener("SIGINT", shutdown);
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "relay_start_failed",
      message: error instanceof Error ? error.message : "unknown error",
    }));
    Deno.exit(78);
  }
}

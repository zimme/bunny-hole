import { dirname, join } from "node:path";
import { VERSION } from "../../packages/api/mod.ts";
import { createLogger } from "../../packages/api/logger.ts";
import { loadHostConfig, redactedHostConfig } from "./config.ts";
import { frpsConfig } from "./frp.ts";
import { Host } from "./host.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { HostStore } from "./store.ts";

export { Host } from "./host.ts";

if (import.meta.main) {
  if (Deno.args[0] === "--healthcheck") {
    try {
      const response = await fetch(
        `http://127.0.0.1:${Deno.env.get("PORT") ?? "8080"}/healthz`,
      );
      Deno.exit(response.ok ? 0 : 1);
    } catch {
      Deno.exit(1);
    }
  }
  try {
    const config = loadHostConfig();
    const logger = createLogger(config.logFormat);
    await Deno.mkdir(dirname(config.statePath), { recursive: true, mode: 0o700 });
    const identity = await loadOrCreateIdentity(config.identityPath);
    using store = new HostStore(config.statePath);
    const host = new Host(config, store, identity, logger);
    const frpsConfigPath = join(dirname(config.statePath), "frps.toml");
    await Deno.writeTextFile(frpsConfigPath, frpsConfig(config), { mode: 0o600 });
    const frps = new Deno.Command(config.frpsPath, {
      args: ["-c", frpsConfigPath],
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    await waitForPort(config.frpBindPort, frps);
    host.setFrpReady(true);
    logger.info("host_starting", {
      version: VERSION,
      config: redactedHostConfig(config),
    });
    const controller = new AbortController();
    const server = Deno.serve(
      {
        hostname: config.bindAddress,
        port: config.port,
        signal: controller.signal,
        onListen: ({ hostname, port }) =>
          logger.info("host_listening", { hostname, port }),
      },
      (request, info) => host.handle(request, info),
    );
    let stopping = false;
    let unexpectedFrpExit = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      host.shutdown();
      try {
        frps.kill("SIGTERM");
      } catch {
        // Child already exited.
      }
      setTimeout(() => controller.abort(), 1_000);
    };
    frps.status.then((status) => {
      host.setFrpReady(false);
      logger.error("frps_stopped", { code: status.code, success: status.success });
      if (!stopping) {
        unexpectedFrpExit = true;
        host.shutdown();
        controller.abort();
      }
    });
    Deno.addSignalListener("SIGTERM", shutdown);
    Deno.addSignalListener("SIGINT", shutdown);
    try {
      await server.finished;
    } finally {
      Deno.removeSignalListener("SIGTERM", shutdown);
      Deno.removeSignalListener("SIGINT", shutdown);
      shutdown();
      await frps.status;
    }
    if (unexpectedFrpExit) throw new Error("frps stopped unexpectedly");
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "host_start_failed",
      message: error instanceof Error ? error.message : "unknown error",
    }));
    Deno.exit(78);
  }
}

async function waitForPort(port: number, child: Deno.ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const connection = await Deno.connect({ hostname: "127.0.0.1", port });
      connection.close();
      return;
    } catch {
      const status = await Promise.race([
        child.status.then((value) => ({ done: true as const, value })),
        new Promise<{ done: false }>((resolve) =>
          setTimeout(() => resolve({ done: false }), 50)
        ),
      ]);
      if (status.done) throw new Error(`frps exited with code ${status.value.code}`);
    }
  }
  throw new Error("frps did not become ready");
}

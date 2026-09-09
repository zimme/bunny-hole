import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunnyHoleClient, type HostCredentials } from "./client.ts";
import { frpcConfig } from "./frpc_config.ts";
import { ValidationError } from "../../packages/api/mod.ts";

export interface ConnectorOptions {
  credentials: HostCredentials;
  frpcPath: string;
  transport?: "wss";
  workingDirectory?: string;
  stderr?: "inherit" | "pipe";
}

export interface ConnectorHandle {
  /** Authenticates and runs one FRP session until it exits or is stopped. */
  run(signal?: AbortSignal): Promise<number>;
  stop(): void;
}

/**
 * Creates an embeddable connector supervisor for Node.js or Deno.
 *
 * The caller supplies a release-matched `frpc` executable. Credentials remain in
 * process memory and a mode-0600 ephemeral profile that is removed after every run.
 */
export function createConnector(options: ConnectorOptions): ConnectorHandle {
  if (!options.frpcPath || options.frpcPath.includes("\0")) {
    throw new ValidationError("frpcPath is required");
  }
  if (options.transport && options.transport !== "wss") {
    throw new ValidationError("library connectors require WSS");
  }
  const client = new BunnyHoleClient(options.credentials.url);
  let controller = new AbortController();
  let child: ChildProcess | undefined;
  let running = false;
  return {
    async run(signal?: AbortSignal): Promise<number> {
      if (running) throw new ValidationError("connector is already running");
      if (signal?.aborted) return 0;
      if (controller.signal.aborted) controller = new AbortController();
      const runController = controller;
      running = true;
      try {
        const session = await client.session(options.credentials);
        if (runController.signal.aborted || signal?.aborted) return 0;
        const directory = await mkdtemp(
          join(options.workingDirectory ?? tmpdir(), "bunny-hole-library-"),
        );
        try {
          const path = join(directory, "frpc.toml");
          await writeFile(path, frpcConfig(session, options.transport ?? "wss"), {
            mode: 0o600,
            flag: "wx",
          });
          if (runController.signal.aborted || signal?.aborted) return 0;
          const abort = () => {
            try {
              child?.kill("SIGTERM");
            } catch {
              // The process may already have exited.
            }
          };
          runController.signal.addEventListener("abort", abort, { once: true });
          signal?.addEventListener("abort", abort, { once: true });
          try {
            child = spawn(options.frpcPath, ["-c", path], {
              stdio: ["ignore", "inherit", options.stderr ?? "inherit"],
              windowsHide: true,
            });
            return await new Promise<number>((resolve, reject) => {
              child!.once("error", reject);
              child!.once("exit", (code, exitSignal) => {
                if (exitSignal && !runController.signal.aborted && !signal?.aborted) {
                  reject(new Error(`frpc stopped by ${exitSignal}`));
                } else {
                  resolve(code ?? 0);
                }
              });
            });
          } finally {
            child = undefined;
            runController.signal.removeEventListener("abort", abort);
            signal?.removeEventListener("abort", abort);
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      } finally {
        running = false;
        if (controller === runController) controller = new AbortController();
      }
    },
    stop(): void {
      controller.abort();
    },
  };
}

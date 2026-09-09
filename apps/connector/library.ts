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
  const controller = new AbortController();
  let child: ChildProcess | undefined;
  return {
    async run(signal?: AbortSignal): Promise<number> {
      if (child) throw new ValidationError("connector is already running");
      if (controller.signal.aborted || signal?.aborted) return 0;
      const session = await client.session(options.credentials);
      const directory = await mkdtemp(
        join(options.workingDirectory ?? tmpdir(), "bunny-hole-library-"),
      );
      const path = join(directory, "frpc.toml");
      await writeFile(path, frpcConfig(session, options.transport ?? "wss"), {
        mode: 0o600,
        flag: "wx",
      });
      const abort = () => child?.kill("SIGTERM");
      controller.signal.addEventListener("abort", abort, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        child = spawn(options.frpcPath, ["-c", path], {
          stdio: ["ignore", "inherit", options.stderr ?? "inherit"],
          windowsHide: true,
        });
        return await new Promise<number>((resolve, reject) => {
          child!.once("error", reject);
          child!.once("exit", (code, exitSignal) => {
            if (exitSignal && !controller.signal.aborted && !signal?.aborted) {
              reject(new Error(`frpc stopped by ${exitSignal}`));
            } else {
              resolve(code ?? 0);
            }
          });
        });
      } finally {
        child = undefined;
        controller.signal.removeEventListener("abort", abort);
        signal?.removeEventListener("abort", abort);
        await rm(directory, { recursive: true, force: true });
      }
    },
    stop(): void {
      controller.abort();
    },
  };
}

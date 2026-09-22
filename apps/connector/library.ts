import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunnyHoleClient, type HostCredentials } from "./client.ts";
import { frpcConfig } from "./frpc_config.ts";
import { ValidationError } from "../../packages/api/mod.ts";

export interface ConnectorOptions {
  credentials: HostCredentials;
  frpcPath: string;
  transport?: "wss";
  workingDirectory?: string;
  stderr?: "inherit" | "pipe";
  /** PEM roots used to verify the connector WSS endpoint. */
  trustedCaFile?: string;
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
  const trustedCaFile = options.trustedCaFile ??
    join(dirname(options.frpcPath), "ca-certificates.crt");
  if (!trustedCaFile || trustedCaFile.includes("\0")) {
    throw new ValidationError("trusted CA bundle path is invalid");
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
        await validateTrustedCaFile(trustedCaFile);
        const session = await client.session(options.credentials);
        if (runController.signal.aborted || signal?.aborted) return 0;
        const directory = await mkdtemp(
          join(options.workingDirectory ?? tmpdir(), "bunny-hole-library-"),
        );
        try {
          const path = join(directory, "frpc.toml");
          await writeFile(
            path,
            frpcConfig(session, options.transport ?? "wss", false, trustedCaFile),
            {
              mode: 0o600,
              flag: "wx",
            },
          );
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
            if (runController.signal.aborted || signal?.aborted) return 0;
            child = spawn(options.frpcPath, ["-c", path], {
              stdio: ["ignore", "inherit", options.stderr ?? "inherit"],
              windowsHide: true,
            });
            if (runController.signal.aborted || signal?.aborted) abort();
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

async function validateTrustedCaFile(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) {
      throw new ValidationError(
        "trusted CA bundle must be a non-empty PEM certificate bundle",
      );
    }
    const pem = await readFile(path, "utf8");
    if (
      !pem.includes("-----BEGIN CERTIFICATE-----") ||
      !pem.includes("-----END CERTIFICATE-----")
    ) {
      throw new ValidationError(
        "trusted CA bundle must be a non-empty PEM certificate bundle",
      );
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ValidationError(`trusted CA bundle is unreadable (${path}): ${detail}`);
  }
}

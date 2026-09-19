import { dirname, join } from "node:path";
import type { Session } from "./client.ts";
import { frpcConfig } from "./frpc_config.ts";

export { frpcConfig } from "./frpc_config.ts";

export interface FrpcOptions {
  executable: string;
  session: Session;
  transport: "quic" | "tcp" | "websocket" | "wss";
  signal?: AbortSignal;
  allowInsecureTransport?: boolean;
  trustedCaFile?: string;
}

export const TRUSTED_CA_FILE_NAME = "ca-certificates.crt";

export function defaultTrustedCaFile(executable: string): string {
  return Deno.env.get("BUNNY_HOLE_TRUSTED_CA_FILE") ??
    join(dirname(executable), TRUSTED_CA_FILE_NAME);
}

export async function runFrpc(options: FrpcOptions): Promise<number> {
  const trustedCaFile = options.transport === "wss"
    ? options.trustedCaFile ?? defaultTrustedCaFile(options.executable)
    : undefined;
  if (trustedCaFile) await assertTrustedCaFile(trustedCaFile);
  const directory = await Deno.makeTempDir({ prefix: "bunny-hole-frpc-" });
  try {
    const configPath = join(directory, "frpc.toml");
    await Deno.writeTextFile(
      configPath,
      frpcConfig(
        options.session,
        options.transport,
        options.allowInsecureTransport,
        trustedCaFile,
      ),
      { mode: 0o600, createNew: true },
    );
    let child: Deno.ChildProcess | undefined;
    const stop = () => {
      try {
        child?.kill("SIGTERM");
      } catch {
        // Already stopped.
      }
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    try {
      if (options.signal?.aborted) return 0;
      child = new Deno.Command(options.executable, {
        args: ["-c", configPath],
        stdin: "null",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      if (options.signal?.aborted) stop();
      return (await child.status).code;
    } finally {
      options.signal?.removeEventListener("abort", stop);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function assertTrustedCaFile(path: string): Promise<void> {
  if (!path || path.includes("\0")) {
    throw new Error("trusted CA bundle path is invalid");
  }
  const info = await Deno.stat(path);
  if (!info.isFile || info.size === 0) {
    throw new Error("trusted CA bundle must be a non-empty regular file");
  }
}

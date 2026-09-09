import { join } from "node:path";
import type { Session } from "./client.ts";
import { frpcConfig } from "./frpc_config.ts";

export { frpcConfig } from "./frpc_config.ts";

export interface FrpcOptions {
  executable: string;
  session: Session;
  transport: "quic" | "tcp" | "websocket" | "wss";
  signal?: AbortSignal;
  allowInsecureTransport?: boolean;
}

export async function runFrpc(options: FrpcOptions): Promise<number> {
  const directory = await Deno.makeTempDir({ prefix: "bunny-hole-frpc-" });
  try {
    const configPath = join(directory, "frpc.toml");
    await Deno.writeTextFile(
      configPath,
      frpcConfig(
        options.session,
        options.transport,
        options.allowInsecureTransport,
      ),
      { mode: 0o600, createNew: true },
    );
    if (options.signal?.aborted) return 0;
    const child = new Deno.Command(options.executable, {
      args: ["-c", configPath],
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const stop = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already stopped.
      }
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    try {
      return (await child.status).code;
    } finally {
      options.signal?.removeEventListener("abort", stop);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

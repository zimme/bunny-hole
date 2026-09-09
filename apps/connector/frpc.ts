import { dirname, join } from "node:path";
import type { Session } from "./client.ts";
import { frpcConfig } from "./frpc_config.ts";

export { frpcConfig } from "./frpc_config.ts";

export interface FrpcOptions {
  executable: string;
  session: Session;
  transport: "quic" | "tcp" | "websocket" | "wss";
  workDirectory: string;
  signal?: AbortSignal;
  allowInsecureTransport?: boolean;
}

export async function runFrpc(options: FrpcOptions): Promise<number> {
  await Deno.mkdir(options.workDirectory, { recursive: true, mode: 0o700 });
  const configPath = join(options.workDirectory, "frpc.toml");
  await Deno.writeTextFile(
    configPath,
    frpcConfig(
      options.session,
      options.transport,
      options.allowInsecureTransport,
    ),
    { mode: 0o600 },
  );
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
    try {
      await Deno.remove(configPath);
      await Deno.remove(dirname(configPath));
    } catch {
      // Best-effort removal; config contains only a short-lived token.
    }
  }
}

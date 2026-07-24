import { decodeBase64Url, ProtocolError } from "../../packages/protocol/mod.ts";
import { validateOrigin } from "../../packages/protocol/security.ts";

export interface ConnectorConfig {
  relayUrl: URL;
  tunnelId: string;
  secret: string;
  origin: URL;
  allowPrivateNetwork: boolean;
  localDevelopment: boolean;
  logFormat: "json" | "pretty";
}

interface ConfigInput {
  relayUrl?: unknown;
  tunnelId?: unknown;
  secret?: unknown;
  origin?: unknown;
  allowPrivateNetwork?: unknown;
  localDevelopment?: unknown;
  logFormat?: unknown;
}

export async function loadConnectorConfig(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined> = readConnectorEnv(),
): Promise<ConnectorConfig> {
  let file: ConfigInput = {};
  if (typeof flags.config === "string") {
    await assertRestrictedFile(flags.config);
    try {
      file = JSON.parse(await Deno.readTextFile(flags.config));
    } catch {
      throw new ProtocolError("configuration file is not valid JSON");
    }
  }
  const localDevelopment = booleanValue(
    flags["local-development"] ??
      env.BUNNY_HOLE_LOCAL_DEVELOPMENT ??
      file.localDevelopment ??
      false,
  );
  const allowPrivateNetwork = booleanValue(
    flags["allow-private-network"] ??
      env.BUNNY_HOLE_ALLOW_PRIVATE_NETWORK ??
      file.allowPrivateNetwork ??
      false,
  );
  const relayRaw = stringValue(
    flags.relay ?? env.BUNNY_HOLE_RELAY_URL ?? file.relayUrl,
    "relay URL",
  );
  let relayUrl: URL;
  try {
    relayUrl = new URL(relayRaw);
  } catch {
    throw new ProtocolError("invalid relay URL");
  }
  if (
    !["wss:", ...(localDevelopment ? ["ws:"] : [])].includes(relayUrl.protocol) ||
    relayUrl.username || relayUrl.password || relayUrl.search || relayUrl.hash
  ) throw new ProtocolError("relay URL must be a clean WSS URL");
  const tunnelId = stringValue(
    flags.tunnel ?? env.BUNNY_HOLE_TUNNEL_ID ?? file.tunnelId,
    "tunnel ID",
  );
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(tunnelId)) {
    throw new ProtocolError("invalid tunnel ID");
  }
  const secret = stringValue(
    env.BUNNY_HOLE_TUNNEL_SECRET ?? file.secret,
    "tunnel secret",
  );
  if (decodeBase64Url(secret).length < 32) {
    throw new ProtocolError("tunnel secret is too short");
  }
  const origin = validateOrigin(
    stringValue(
      flags.origin ?? env.BUNNY_HOLE_ORIGIN ?? file.origin ?? "http://127.0.0.1:3000",
      "origin",
    ),
    allowPrivateNetwork,
  );
  const logFormat =
    (flags["log-format"] ?? env.BUNNY_HOLE_LOG_FORMAT ?? file.logFormat) === "pretty"
      ? "pretty"
      : "json";
  return {
    relayUrl,
    tunnelId,
    secret,
    origin,
    allowPrivateNetwork,
    localDevelopment,
    logFormat,
  };
}

function readConnectorEnv(): Record<string, string | undefined> {
  return Object.fromEntries([
    "BUNNY_HOLE_LOCAL_DEVELOPMENT",
    "BUNNY_HOLE_ALLOW_PRIVATE_NETWORK",
    "BUNNY_HOLE_RELAY_URL",
    "BUNNY_HOLE_TUNNEL_ID",
    "BUNNY_HOLE_TUNNEL_SECRET",
    "BUNNY_HOLE_ORIGIN",
    "BUNNY_HOLE_LOG_FORMAT",
  ].map((name) => [name, Deno.env.get(name)]));
}

export function redactedConnectorConfig(
  config: ConnectorConfig,
): Record<string, unknown> {
  return {
    relayUrl: config.relayUrl.href,
    tunnelId: config.tunnelId,
    secret: "[REDACTED]",
    origin: config.origin.href,
    allowPrivateNetwork: config.allowPrivateNetwork,
    localDevelopment: config.localDevelopment,
    logFormat: config.logFormat,
  };
}

async function assertRestrictedFile(path: string): Promise<void> {
  const info = await Deno.stat(path);
  if (!info.isFile || info.size > 65_536) {
    throw new ProtocolError("configuration file must be a regular file up to 64 KiB");
  }
  if (Deno.build.os !== "windows" && (info.mode ?? 0) & 0o077) {
    throw new ProtocolError("configuration file permissions must be 0600 or stricter");
  }
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError(`${name} is required`);
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new ProtocolError("boolean configuration values must be true or false");
}

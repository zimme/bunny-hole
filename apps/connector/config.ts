import { ProtocolError } from "../../packages/protocol/mod.ts";
import { validateConnectorOptions } from "./library.ts";

export interface ConnectorConfig {
  relayUrl: URL;
  tunnelId: string;
  privateKey: string;
  origin: URL;
  allowPrivateNetwork: boolean;
  localDevelopment: boolean;
  logFormat: "json" | "pretty";
}

interface ConfigInput {
  relayUrl?: unknown;
  tunnelId?: unknown;
  privateKey?: unknown;
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
    if (!isConfigInput(file)) {
      throw new ProtocolError("configuration file has unknown or invalid fields");
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
  const tunnelId = stringValue(
    flags.tunnel ?? env.BUNNY_HOLE_TUNNEL_ID ?? file.tunnelId,
    "tunnel ID",
  );
  const privateKey = stringValue(
    env.BUNNY_HOLE_TUNNEL_PRIVATE_KEY ?? file.privateKey,
    "tunnel private key",
  );
  const validated = validateConnectorOptions({
    relayUrl: relayRaw,
    tunnelId,
    privateKey,
    origin: stringValue(
      flags.origin ?? env.BUNNY_HOLE_ORIGIN ?? file.origin ?? "http://127.0.0.1:3000",
      "origin",
    ),
    allowPrivateNetwork,
    localDevelopment,
  });
  const logFormat = flags["log-format"] ?? env.BUNNY_HOLE_LOG_FORMAT ??
    file.logFormat ?? "json";
  if (logFormat !== "json" && logFormat !== "pretty") {
    throw new ProtocolError("log format must be json or pretty");
  }
  return {
    ...validated,
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
    "BUNNY_HOLE_TUNNEL_PRIVATE_KEY",
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
    privateKey: "[REDACTED]",
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

function isConfigInput(value: unknown): value is ConfigInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const allowed = new Set([
    "relayUrl",
    "tunnelId",
    "privateKey",
    "origin",
    "allowPrivateNetwork",
    "localDevelopment",
    "logFormat",
  ]);
  return Object.keys(value).every((key) => allowed.has(key));
}

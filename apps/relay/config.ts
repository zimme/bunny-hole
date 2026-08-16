import { decodeBase64Url, LIMITS, ProtocolError } from "../../packages/protocol/mod.ts";
import { normalizeHostname } from "../../packages/protocol/security.ts";

export interface TunnelConfig {
  id: string;
  secret: string;
  hostnames: string[];
}

export interface RelayConfig {
  hostname: string;
  port: number;
  localDevelopment: boolean;
  logFormat: "json" | "pretty";
  tunnels: Map<string, TunnelConfig>;
  hostnameToTunnel: Map<string, string>;
}

export function loadRelayConfig(
  env: Record<string, string | undefined> = readRelayEnv(),
): RelayConfig {
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProtocolError("PORT must be an integer from 1 to 65535");
  }
  const hostname = env.HOST ?? "0.0.0.0";
  const localDevelopmentValue = env.BUNNY_HOLE_LOCAL_DEVELOPMENT ?? "false";
  if (localDevelopmentValue !== "true" && localDevelopmentValue !== "false") {
    throw new ProtocolError("BUNNY_HOLE_LOCAL_DEVELOPMENT must be true or false");
  }
  const localDevelopment = localDevelopmentValue === "true";
  const logFormat = env.BUNNY_HOLE_LOG_FORMAT ?? "json";
  if (logFormat !== "json" && logFormat !== "pretty") {
    throw new ProtocolError("BUNNY_HOLE_LOG_FORMAT must be json or pretty");
  }
  const rawTunnels = env.BUNNY_HOLE_TUNNELS;
  if (!rawTunnels) throw new ProtocolError("BUNNY_HOLE_TUNNELS is required");
  if (rawTunnels.length > 8 * 1024 * 1024) {
    throw new ProtocolError("BUNNY_HOLE_TUNNELS exceeds the 8 MiB limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTunnels);
  } catch {
    throw new ProtocolError("BUNNY_HOLE_TUNNELS must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 1_000) {
    throw new ProtocolError("BUNNY_HOLE_TUNNELS must contain 1-1000 tunnels");
  }

  const tunnels = new Map<string, TunnelConfig>();
  const hostnameToTunnel = new Map<string, string>();
  for (const candidate of parsed) {
    if (!isRecord(candidate)) throw new ProtocolError("invalid tunnel configuration");
    if (
      Object.keys(candidate).some((key) => !["id", "secret", "hostnames"].includes(key))
    ) {
      throw new ProtocolError("tunnel configuration contains unknown fields");
    }
    const id = candidate.id;
    const secret = candidate.secret;
    const hostnames = candidate.hostnames;
    if (
      typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(id) ||
      typeof secret !== "string" || !Array.isArray(hostnames) ||
      hostnames.length < 1 || hostnames.length > 20
    ) throw new ProtocolError("invalid tunnel configuration");
    if (decodeBase64Url(secret).length < 32) {
      throw new ProtocolError(`secret for tunnel ${id} is too short`);
    }
    if (tunnels.has(id)) throw new ProtocolError(`duplicate tunnel id: ${id}`);
    const normalized = hostnames.map((value) => {
      if (typeof value !== "string") throw new ProtocolError("invalid hostname");
      return normalizeHostname(value);
    });
    for (const host of normalized) {
      if (hostnameToTunnel.has(host)) {
        throw new ProtocolError(`hostname is assigned more than once: ${host}`);
      }
      hostnameToTunnel.set(host, id);
    }
    tunnels.set(id, { id, secret, hostnames: normalized });
  }
  return {
    hostname,
    port,
    localDevelopment,
    logFormat,
    tunnels,
    hostnameToTunnel,
  };
}

function readRelayEnv(): Record<string, string | undefined> {
  return Object.fromEntries([
    "PORT",
    "HOST",
    "BUNNY_HOLE_LOCAL_DEVELOPMENT",
    "BUNNY_HOLE_LOG_FORMAT",
    "BUNNY_HOLE_TUNNELS",
  ].map((name) => [name, Deno.env.get(name)]));
}

export function redactedConfig(config: RelayConfig): Record<string, unknown> {
  return {
    hostname: config.hostname,
    port: config.port,
    localDevelopment: config.localDevelopment,
    logFormat: config.logFormat,
    limits: LIMITS,
    tunnels: [...config.tunnels.values()].map(({ id, hostnames }) => ({
      id,
      hostnames,
      secret: "[REDACTED]",
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { validatePublicKey } from "../../packages/api/auth.ts";
import {
  type HostDescriptor,
  normalizeHostname,
  parsePort,
  ValidationError,
} from "../../packages/api/mod.ts";

export interface HostConfig {
  bindAddress: string;
  port: number;
  publicUrl: URL;
  statePath: string;
  identityPath: string;
  ownerPublicKey: string;
  frpsPath: string;
  frpBindPort: number;
  frpHttpPort: number;
  connectorHost: string;
  connectorPort: number;
  connectorTransports: HostDescriptor["connectorTransports"];
  requestTimeoutMs: number;
  logFormat: "json" | "pretty";
  localDevelopment: boolean;
}

export function loadHostConfig(env = Deno.env.toObject()): HostConfig {
  const localDevelopment = env.BUNNY_HOLE_LOCAL_DEVELOPMENT === "true";
  if (!localDevelopment && !env.BUNNY_HOLE_PUBLIC_URL) {
    throw new ValidationError("BUNNY_HOLE_PUBLIC_URL is required");
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(
      env.BUNNY_HOLE_PUBLIC_URL ?? "http://127.0.0.1:8080",
    );
  } catch {
    throw new ValidationError("invalid public URL");
  }
  if (!localDevelopment && publicUrl.protocol !== "https:") {
    throw new ValidationError("public URL must use HTTPS");
  }
  if (
    !publicUrl.hostname || publicUrl.username || publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash || publicUrl.pathname !== "/"
  ) throw new ValidationError("public URL must contain only an origin");
  if (!localDevelopment) normalizeHostname(publicUrl.hostname);

  const ownerPublicKey = env.BUNNY_HOLE_OWNER_PUBLIC_KEY;
  if (!ownerPublicKey) {
    throw new ValidationError("BUNNY_HOLE_OWNER_PUBLIC_KEY is required");
  }
  const connectorHost = normalizeHostname(
    env.BUNNY_HOLE_CONNECTOR_HOST ?? publicUrl.hostname,
  );
  const connectorTransports = (env.BUNNY_HOLE_CONNECTOR_TRANSPORTS ??
    (localDevelopment ? "tcp,quic" : "wss"))
    .split(",").map((value) => value.trim()) as HostDescriptor["connectorTransports"];
  if (
    connectorTransports.length === 0 ||
    new Set(connectorTransports).size !== connectorTransports.length ||
    connectorTransports.some((value) => !["quic", "tcp", "wss"].includes(value)) ||
    (!localDevelopment && connectorTransports.some((value) => value !== "wss"))
  ) throw new ValidationError("invalid connector transports");
  const port = parsePort(Number(env.PORT ?? "8080"));
  const frpBindPort = parsePort(Number(env.BUNNY_HOLE_FRP_BIND_PORT ?? "7000"));
  const frpHttpPort = parsePort(Number(env.BUNNY_HOLE_FRP_HTTP_PORT ?? "9080"));
  if (new Set([port, frpBindPort, frpHttpPort]).size !== 3) {
    throw new ValidationError("host ports must be distinct");
  }
  const requestTimeoutMs = Number(
    env.BUNNY_HOLE_REQUEST_TIMEOUT_MS ?? "30000",
  );
  if (
    !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 ||
    requestTimeoutMs > 120_000
  ) throw new ValidationError("invalid request timeout");
  const logFormat = env.BUNNY_HOLE_LOG_FORMAT ?? "json";
  if (!["json", "pretty"].includes(logFormat)) {
    throw new ValidationError("invalid log format");
  }
  const statePath = env.BUNNY_HOLE_STATE_PATH ?? "/var/lib/bunny-hole/state.sqlite";
  const identityPath = env.BUNNY_HOLE_IDENTITY_PATH ??
    "/var/lib/bunny-hole/identity.json";
  const frpsPath = env.BUNNY_HOLE_FRPS_PATH ?? "/usr/local/bin/frps";
  if (![statePath, identityPath, frpsPath].every((value) => value.length > 0)) {
    throw new ValidationError("host paths must not be empty");
  }
  return {
    bindAddress: env.HOST ?? "0.0.0.0",
    port,
    publicUrl,
    statePath,
    identityPath,
    ownerPublicKey: validatePublicKey(ownerPublicKey),
    frpsPath,
    frpBindPort,
    frpHttpPort,
    connectorHost,
    connectorPort: parsePort(Number(
      env.BUNNY_HOLE_CONNECTOR_PORT ?? (localDevelopment ? "7000" : "443"),
    )),
    connectorTransports,
    requestTimeoutMs,
    logFormat: logFormat as HostConfig["logFormat"],
    localDevelopment,
  };
}

export function redactedHostConfig(config: HostConfig): Record<string, unknown> {
  return {
    bindAddress: config.bindAddress,
    port: config.port,
    publicUrl: config.publicUrl.href,
    statePath: config.statePath,
    identityPath: config.identityPath,
    ownerKeyConfigured: true,
    frpsPath: config.frpsPath,
    frpBindPort: config.frpBindPort,
    frpHttpPort: config.frpHttpPort,
    connectorHost: config.connectorHost,
    connectorPort: config.connectorPort,
    connectorTransports: config.connectorTransports,
    requestTimeoutMs: config.requestTimeoutMs,
    logFormat: config.logFormat,
    localDevelopment: config.localDevelopment,
  };
}

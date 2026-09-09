/** Public Bunny Hole control-plane API model. */
export const API_VERSION = 1;
export const VERSION = "0.1.0";

export const LIMITS = Object.freeze({
  maxBodyBytes: 1024 * 1024 * 1024,
  maxHeaderBytes: 32_768,
  maxHeaders: 100,
  maxConcurrentRequests: 64,
  maxRoutesPerEnrollment: 256,
  maxEnrollments: 1_024,
  maxEnrollmentAttemptsPerMinute: 30,
  maxNameBytes: 128,
  maxPathBytes: 8_192,
  enrollmentLifetimeMs: 15 * 60_000,
  sessionTokenLifetimeMs: 5 * 60_000,
  heartbeatIntervalMs: 20_000,
  heartbeatTimeoutMs: 45_000,
});

export type RouteProtocol = "http" | "https";
export type EnrollmentKind = "device" | "cluster";
export type EnrollmentState = "pending" | "active" | "revoked";

export interface EnrollmentGrant {
  hostnameSuffixes: string[];
  exactHostnames: string[];
  protocols: RouteProtocol[];
  maxRoutes: number;
}

export interface Enrollment {
  id: string;
  kind: EnrollmentKind;
  name: string;
  publicKey: string;
  verificationPhrase: string;
  state: EnrollmentState;
  grants: EnrollmentGrant;
  createdAt: string;
  expiresAt: string | null;
}

export interface Route {
  id: string;
  enrollmentId: string;
  name: string;
  protocol: RouteProtocol;
  targetHost: string;
  targetPort: number;
  hostname: string;
  allowPrivateNetwork: boolean;
  active: boolean;
}

export interface HostDescriptor {
  apiVersion: number;
  name: string;
  managementUrl: string;
  connectorHost: string;
  connectorPort: number;
  connectorTransports: Array<"quic" | "tcp" | "wss">;
  identityPublicKey: string;
  capabilities: RouteProtocol[];
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function createId(prefix: string): string {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(prefix)) {
    throw new ValidationError("invalid identifier prefix");
  }
  return `${prefix}_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)))}`;
}

export function parseId(value: unknown, prefix: string): string {
  if (
    !/^[a-z][a-z0-9]{1,15}$/.test(prefix) ||
    typeof value !== "string" ||
    !new RegExp(`^${prefix}_[A-Za-z0-9_-]{24}$`).test(value)
  ) throw new ValidationError("invalid identifier");
  return value;
}

export function parseName(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("invalid name");
  const name = value.trim();
  if (
    name.length < 1 ||
    new TextEncoder().encode(name).byteLength > LIMITS.maxNameBytes ||
    /[\0\r\n]/.test(name)
  ) throw new ValidationError("invalid name");
  return name;
}

export function parseProtocol(value: unknown): RouteProtocol {
  if (!["http", "https"].includes(String(value))) {
    throw new ValidationError("invalid route protocol");
  }
  return value as RouteProtocol;
}

export function parsePort(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535
  ) {
    throw new ValidationError("invalid port");
  }
  return value;
}

export function normalizeHostname(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("invalid hostname");
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (/[\0-\x20\x7f]/.test(value) || value.length > 253) {
    throw new ValidationError("invalid hostname");
  }
  if (
    !value.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))
  ) throw new ValidationError("invalid hostname");
  return value;
}

export function validateGrant(value: unknown): EnrollmentGrant {
  if (!isRecord(value)) throw new ValidationError("invalid grant");
  const allowed = new Set([
    "hostnameSuffixes",
    "exactHostnames",
    "protocols",
    "maxRoutes",
  ]);
  if (Object.keys(value).some((name) => !allowed.has(name))) {
    throw new ValidationError("unknown grant field");
  }
  const hostnameSuffixes = stringArray(value.hostnameSuffixes).map(normalizeHostname);
  const exactHostnames = stringArray(value.exactHostnames).map(normalizeHostname);
  const protocols = stringArray(value.protocols).map(parseProtocol);
  const maxRoutes = value.maxRoutes;
  if (
    typeof maxRoutes !== "number" || !Number.isInteger(maxRoutes) || maxRoutes < 1 ||
    maxRoutes > LIMITS.maxRoutesPerEnrollment
  ) throw new ValidationError("invalid route limit");
  return {
    hostnameSuffixes: unique(hostnameSuffixes),
    exactHostnames: unique(exactHostnames),
    protocols: unique(protocols),
    maxRoutes,
  };
}

export function grantAllowsRoute(grant: EnrollmentGrant, route: Route): boolean {
  if (!grant.protocols.includes(route.protocol)) return false;
  if (route.hostname) {
    const hostname = normalizeHostname(route.hostname);
    if (
      !grant.exactHostnames.includes(hostname) &&
      !grant.hostnameSuffixes.some((suffix) =>
        hostname === suffix || hostname.endsWith(`.${suffix}`)
      )
    ) return false;
  }
  return true;
}

/** Stable, order-independent representation used by owner approval signatures. */
export function canonicalGrant(grant: EnrollmentGrant): string {
  return JSON.stringify({
    exactHostnames: [...grant.exactHostnames].sort(),
    hostnameSuffixes: [...grant.hostnameSuffixes].sort(),
    maxRoutes: grant.maxRoutes,
    protocols: [...grant.protocols].sort(),
  });
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ValidationError("invalid encoding");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new ValidationError("invalid encoding");
  }
}

function stringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) || value.length > 256 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new ValidationError("invalid string list");
  }
  return value as string[];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

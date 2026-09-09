import {
  API_VERSION,
  decodeBase64Url,
  type EnrollmentKind,
  type HostDescriptor,
  isRecord,
  normalizeHostname,
  parseId,
  parseName,
  parsePort,
  parseProtocol,
  type Route,
  ValidationError,
} from "../../packages/api/mod.ts";
import { validateOrigin } from "../../packages/api/security.ts";
import { sign, validatePublicKey } from "../../packages/api/auth.ts";

export interface HostCredentials {
  url: string;
  identityPublicKey: string;
  enrollmentId: string;
  publicKey: string;
  privateKey: string;
}

export function parseHostCredentials(value: unknown): HostCredentials {
  if (!isRecord(value) || typeof value.url !== "string") {
    throw new ValidationError("invalid host credentials");
  }
  const fields = new Set([
    "url",
    "identityPublicKey",
    "enrollmentId",
    "publicKey",
    "privateKey",
  ]);
  if (Object.keys(value).some((name) => !fields.has(name))) {
    throw new ValidationError("invalid host credentials");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new ValidationError("invalid host credentials");
  }
  if (
    !["https:", "http:"].includes(url.protocol) || url.username || url.password ||
    url.search || url.hash || url.pathname !== "/" ||
    typeof value.privateKey !== "string" ||
    decodeBase64Url(value.privateKey).length !== 32
  ) throw new ValidationError("invalid host credentials");
  return {
    url: url.href,
    identityPublicKey: validatePublicKey(value.identityPublicKey),
    enrollmentId: parseId(value.enrollmentId, "enr"),
    publicKey: validatePublicKey(value.publicKey),
    privateKey: value.privateKey,
  };
}

export interface Session {
  enrollmentId: string;
  accessToken: string;
  expiresAt: string;
  descriptor: HostDescriptor;
  routes: Route[];
}

export class BunnyHoleClient {
  readonly url: URL;

  constructor(
    url: string | URL,
    private fetcher: typeof fetch = fetch,
    private localDevelopment = false,
  ) {
    this.url = new URL(url);
    if (
      this.url.protocol !== "https:" &&
      !(localDevelopment && this.url.protocol === "http:")
    ) {
      throw new ValidationError("host URL must use HTTPS");
    }
    if (
      this.url.username || this.url.password || this.url.search || this.url.hash ||
      this.url.pathname !== "/"
    ) {
      throw new ValidationError("invalid host URL");
    }
  }

  async descriptor(): Promise<HostDescriptor> {
    return parseDescriptor(
      await this.request("/.well-known/bunny-hole"),
      this.url,
      this.localDevelopment,
    );
  }

  async enroll(
    name: string,
    kind: EnrollmentKind,
    publicKey: string,
  ): Promise<{ id: string; state: string; verificationPhrase: string }> {
    const enrollment = parseEnrollment(
      await this.request("/api/v1/enrollments", {
        method: "POST",
        body: JSON.stringify({ name, kind, publicKey }),
      }),
    );
    if (enrollment.publicKey !== validatePublicKey(publicKey)) {
      throw new ValidationError("invalid enrollment response");
    }
    return enrollment;
  }

  async enrollment(id: string): Promise<{ state: string }> {
    const enrollment = parseEnrollment(
      await this.request(`/api/v1/enrollments/${encodeURIComponent(id)}`),
    );
    if (enrollment.id !== parseId(id, "enr")) {
      throw new ValidationError("invalid enrollment response");
    }
    return enrollment;
  }

  async session(credentials: HostCredentials): Promise<Session> {
    const challenge = await this.request("/api/v1/session/challenge", {
      method: "POST",
      body: JSON.stringify({ enrollmentId: credentials.enrollmentId }),
    });
    if (
      !isRecord(challenge) || typeof challenge.challengeId !== "string" ||
      typeof challenge.challenge !== "string" ||
      !hasOnlyKeys(challenge, ["challengeId", "challenge", "expiresAt"])
    ) throw new ValidationError("invalid challenge response");
    parseId(challenge.challengeId, "chl");
    if (!/^[A-Za-z0-9_-]{32}$/.test(challenge.challenge)) {
      throw new ValidationError("invalid challenge response");
    }
    const challengeExpiry = Date.parse(String(challenge.expiresAt));
    if (
      !Number.isFinite(challengeExpiry) || challengeExpiry <= Date.now() ||
      challengeExpiry > Date.now() + 2 * 60_000
    ) throw new ValidationError("invalid challenge response");
    const signature = await sign(credentials.privateKey, "session", [
      credentials.enrollmentId,
      challenge.challengeId,
      challenge.challenge,
    ]);
    const value = await this.request("/api/v1/session", {
      method: "POST",
      body: JSON.stringify({
        enrollmentId: credentials.enrollmentId,
        challengeId: challenge.challengeId,
        signature,
      }),
    });
    if (
      !isRecord(value) || typeof value.accessToken !== "string" ||
      value.accessToken.length === 0 ||
      value.accessToken.length > 1_024 || typeof value.expiresAt !== "string" ||
      !Array.isArray(value.routes) || value.routes.length > 256 ||
      !hasOnlyKeys(value, ["accessToken", "expiresAt", "descriptor", "routes"])
    ) throw new ValidationError("invalid session response");
    const expiresAt = Date.parse(value.expiresAt);
    if (
      !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
      expiresAt > Date.now() + 10 * 60_000
    ) throw new ValidationError("invalid session response");
    const descriptor = parseDescriptor(
      value.descriptor,
      this.url,
      this.localDevelopment,
    );
    if (descriptor.identityPublicKey !== credentials.identityPublicKey) {
      throw new ValidationError("host identity changed");
    }
    const routes = value.routes.map(parseRoute);
    if (routes.some((route) => route.enrollmentId !== credentials.enrollmentId)) {
      throw new ValidationError("invalid session response");
    }
    return {
      enrollmentId: credentials.enrollmentId,
      accessToken: value.accessToken,
      expiresAt: value.expiresAt,
      descriptor,
      routes,
    };
  }

  async createRoute(
    session: Session,
    route: Omit<Route, "id" | "enrollmentId" | "active">,
  ): Promise<Route> {
    return parseRoute(
      await this.request("/api/v1/routes", {
        method: "POST",
        headers: { authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(route),
      }),
    );
  }

  async deleteRoute(session: Session, routeId: string): Promise<void> {
    await this.request(`/api/v1/routes/${encodeURIComponent(routeId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.accessToken}` },
    }, true);
  }

  private async request(
    path: string,
    init: RequestInit = {},
    empty = false,
  ): Promise<unknown> {
    const response = await this.fetcher(new URL(path, this.url), {
      ...init,
      redirect: "error",
      headers: { "content-type": "application/json", ...init.headers },
    });
    if (empty && response.ok) return undefined;
    if (
      (response.headers.get("content-type") ?? "").split(";", 1)[0].trim()
        .toLowerCase() !== "application/json"
    ) throw new ValidationError("host returned an invalid response");
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1024 * 1024)) {
      throw new ValidationError("host response exceeded the limit");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new ValidationError("host response exceeded the limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ValidationError("host returned an invalid response");
    }
    if (!response.ok) {
      throw new ValidationError(`host request failed (${response.status})`);
    }
    return value;
  }
}

function parseRoute(value: unknown): Route {
  if (
    !isRecord(value) || typeof value.allowPrivateNetwork !== "boolean" ||
    typeof value.active !== "boolean" ||
    !hasOnlyKeys(value, [
      "id",
      "enrollmentId",
      "name",
      "protocol",
      "hostname",
      "targetHost",
      "targetPort",
      "allowPrivateNetwork",
      "active",
    ])
  ) throw new ValidationError("invalid session response");
  const route = {
    id: parseId(value.id, "rte"),
    enrollmentId: parseId(value.enrollmentId, "enr"),
    name: parseName(value.name),
    protocol: parseProtocol(value.protocol),
    hostname: normalizeHostname(value.hostname),
    targetHost: parseName(value.targetHost),
    targetPort: parsePort(value.targetPort),
    allowPrivateNetwork: value.allowPrivateNetwork,
    active: value.active,
  };
  validateOrigin(
    `${route.protocol}://${
      route.targetHost.includes(":") ? `[${route.targetHost}]` : route.targetHost
    }:${route.targetPort}`,
    route.allowPrivateNetwork,
  );
  return route;
}

function parseDescriptor(
  value: unknown,
  expectedUrl: URL,
  localDevelopment: boolean,
): HostDescriptor {
  if (
    !isRecord(value) || value.apiVersion !== API_VERSION ||
    typeof value.name !== "string" || typeof value.managementUrl !== "string" ||
    typeof value.connectorHost !== "string" ||
    !Array.isArray(value.connectorTransports) ||
    value.connectorTransports.length < 1 || value.connectorTransports.length > 3 ||
    value.connectorTransports.some((item) => !["wss", "quic", "tcp"].includes(item)) ||
    new Set(value.connectorTransports).size !== value.connectorTransports.length ||
    (!localDevelopment && value.connectorTransports.some((item) => item !== "wss")) ||
    !Array.isArray(value.capabilities) || value.capabilities.length > 2 ||
    new Set(value.capabilities).size !== value.capabilities.length ||
    !hasOnlyKeys(value, [
      "apiVersion",
      "name",
      "managementUrl",
      "connectorHost",
      "connectorPort",
      "connectorTransports",
      "identityPublicKey",
      "capabilities",
    ])
  ) throw new ValidationError("incompatible Bunny Hole host");
  let managementUrl: URL;
  try {
    managementUrl = new URL(value.managementUrl);
  } catch {
    throw new ValidationError("incompatible Bunny Hole host");
  }
  if (
    (!localDevelopment && managementUrl.origin !== expectedUrl.origin) ||
    managementUrl.pathname !== "/" ||
    managementUrl.search || managementUrl.hash ||
    (!localDevelopment && normalizeHostname(value.name) !== expectedUrl.hostname) ||
    value.capabilities.some((item) => {
      try {
        parseProtocol(item);
        return false;
      } catch {
        return true;
      }
    })
  ) throw new ValidationError("incompatible Bunny Hole host");
  return {
    apiVersion: API_VERSION,
    name: normalizeHostname(value.name),
    managementUrl: managementUrl.href,
    connectorHost: normalizeHostname(value.connectorHost),
    connectorPort: parsePort(value.connectorPort),
    connectorTransports: value
      .connectorTransports as HostDescriptor["connectorTransports"],
    identityPublicKey: validatePublicKey(value.identityPublicKey),
    capabilities: value.capabilities.map(parseProtocol),
  };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((name) => names.has(name));
}

function parseEnrollment(value: unknown): {
  id: string;
  publicKey: string;
  state: string;
  verificationPhrase: string;
} {
  if (
    !isRecord(value) || !hasOnlyKeys(value, [
      "id",
      "name",
      "kind",
      "publicKey",
      "state",
      "verificationPhrase",
      "createdAt",
      "expiresAt",
    ]) || !["device", "cluster"].includes(String(value.kind)) ||
    !["pending", "active", "revoked"].includes(String(value.state)) ||
    typeof value.verificationPhrase !== "string" ||
    value.verificationPhrase.length > 128 ||
    typeof value.createdAt !== "string" ||
    (value.expiresAt !== null && typeof value.expiresAt !== "string")
  ) throw new ValidationError("invalid enrollment response");
  parseName(value.name);
  if (!Number.isFinite(Date.parse(value.createdAt))) {
    throw new ValidationError("invalid enrollment response");
  }
  if (
    typeof value.expiresAt === "string" && !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new ValidationError("invalid enrollment response");
  }
  return {
    id: parseId(value.id, "enr"),
    publicKey: validatePublicKey(value.publicKey),
    state: value.state as string,
    verificationPhrase: value.verificationPhrase,
  };
}

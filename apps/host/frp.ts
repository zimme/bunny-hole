import type { HostConfig } from "./config.ts";
import type { HostStore } from "./store.ts";
import type { Route } from "../../packages/api/mod.ts";
import { isRecord, LIMITS } from "../../packages/api/mod.ts";
import { verifySessionToken } from "./session.ts";

export function frpsConfig(config: HostConfig): string {
  const quic = config.localDevelopment && config.connectorTransports.includes("quic")
    ? `quicBindPort = ${config.frpBindPort}\n`
    : "";
  return `bindAddr = "0.0.0.0"
bindPort = ${config.frpBindPort}
${quic}vhostHTTPPort = ${config.frpHttpPort}
transport.maxPoolCount = 16
transport.tcpMux = true
transport.tcpMuxKeepaliveInterval = ${LIMITS.heartbeatIntervalMs / 1_000}
transport.heartbeatTimeout = ${LIMITS.heartbeatTimeoutMs / 1_000}
transport.tls.force = true
auth.method = "token"
auth.token = "bunny-hole-plugin-enforced"
detailedErrorsToClient = false
maxPortsPerClient = 256
[[httpPlugins]]
name = "bunny-hole"
addr = "127.0.0.1:${config.port}"
path = "/internal/frp/plugin"
ops = ["Login", "NewProxy", "CloseProxy", "Ping", "NewWorkConn", "NewUserConn"]
`;
}

export class FrpAuthorizer {
  #active = new Map<string, { jti: string; tokenDigest: string }>();

  constructor(
    private store: HostStore,
    private hostPublicKey: string,
  ) {}

  async authorize(value: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(value) || typeof value.op !== "string" || !isRecord(value.content)) {
      return reject("malformed request");
    }
    const token = metadataToken(value.content);
    if (!token) return reject("authentication required");
    if (value.op === "Login") {
      const claims = await verifySessionToken(this.hostPublicKey, token);
      if (!claims) return reject("authentication failed");
      const enrollment = this.store.getEnrollment(claims.enrollmentId);
      if (!enrollment || enrollment.state !== "active") {
        return reject("authentication failed");
      }
      this.#active.set(enrollment.id, {
        jti: claims.jti,
        tokenDigest: await tokenDigest(token),
      });
      return accept(value.content);
    }
    const digest = await tokenDigest(token);
    const active = [...this.#active.entries()].find(([, session]) =>
      session.tokenDigest === digest
    );
    if (!active) return reject("session replaced");
    const [enrollmentId] = active;
    const enrollment = this.store.getEnrollment(enrollmentId);
    if (!enrollment || enrollment.state !== "active") {
      return reject("authentication failed");
    }
    if (value.op === "NewProxy") {
      const route = routeForProxy(
        enrollment.id,
        this.store.listRoutes(enrollment.id),
        value.content,
      );
      if (!route) return reject("proxy is not authorized");
    } else if (
      !["CloseProxy", "Ping", "NewWorkConn", "NewUserConn"].includes(value.op)
    ) {
      return reject("unsupported operation");
    }
    return accept(value.content);
  }
}

function metadataToken(content: Record<string, unknown>): string | undefined {
  const user = isRecord(content.user) ? content.user : undefined;
  const metas = isRecord(content.metas)
    ? content.metas
    : isRecord(user?.metas)
    ? user.metas
    : undefined;
  const token = metas?.bunny_hole_token;
  return typeof token === "string" && token.length <= 1_024 ? token : undefined;
}

function routeForProxy(
  enrollmentId: string,
  routes: Route[],
  content: Record<string, unknown>,
): Route | undefined {
  const name = content.proxy_name;
  const type = content.proxy_type;
  if (typeof name !== "string" || typeof type !== "string") return undefined;
  const route = routes.find((item) => `bh-${enrollmentId}.bh-${item.id}` === name);
  if (!route) return undefined;
  const expectedType = "http";
  if (type !== expectedType) return undefined;
  const domains = content.custom_domains;
  return Array.isArray(domains) && domains.length === 1 &&
      domains[0] === route.hostname
    ? route
    : undefined;
}

function accept(content: Record<string, unknown>): Record<string, unknown> {
  return { reject: false, unchange: true, content };
}

function reject(reason: string): Record<string, unknown> {
  return { reject: true, reject_reason: reason, unchange: true };
}

async function tokenDigest(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

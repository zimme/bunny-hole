import type { Session } from "./client.ts";
import { LIMITS, type Route } from "../../packages/api/mod.ts";
import { validateOrigin } from "../../packages/api/security.ts";

export function frpcConfig(
  session: Session,
  transport: "quic" | "tcp" | "websocket" | "wss",
  allowInsecureTransport = false,
): string {
  if (transport !== "wss" && !allowInsecureTransport) {
    throw new Error("production connectors require the wss transport");
  }
  const lines = [
    `serverAddr = ${toml(session.descriptor.connectorHost)}`,
    `serverPort = ${session.descriptor.connectorPort}`,
    `user = ${toml(`bh-${session.routes[0]?.enrollmentId ?? "device"}`)}`,
    `transport.protocol = ${toml(transport)}`,
    "transport.tcpMux = true",
    `transport.tcpMuxKeepaliveInterval = ${LIMITS.heartbeatIntervalMs / 1_000}`,
    `transport.heartbeatInterval = ${LIMITS.heartbeatIntervalMs / 1_000}`,
    `transport.heartbeatTimeout = ${LIMITS.heartbeatTimeoutMs / 1_000}`,
    "transport.tls.enable = true",
    'auth.method = "token"',
    'auth.token = "bunny-hole-plugin-enforced"',
    `metadatas.bunny_hole_token = ${toml(session.accessToken)}`,
  ];
  for (const route of session.routes) {
    lines.push("", ...proxyConfig(route, session.accessToken));
  }
  return `${lines.join("\n")}\n`;
}

function proxyConfig(route: Route, token: string): string[] {
  const host = route.targetHost.includes(":")
    ? `[${route.targetHost}]`
    : route.targetHost;
  validateOrigin(
    `${route.protocol}://${host}:${route.targetPort}`,
    route.allowPrivateNetwork,
  );
  const lines = [
    "[[proxies]]",
    `name = ${toml(`bh-${route.id}`)}`,
    'type = "http"',
    `metadatas.bunny_hole_token = ${toml(token)}`,
  ];
  if (route.hostname) lines.push(`customDomains = [${toml(route.hostname)}]`);
  if (route.protocol === "https") {
    lines.push(
      "[proxies.plugin]",
      'type = "http2https"',
      `localAddr = ${toml(`${formatHost(route.targetHost)}:${route.targetPort}`)}`,
    );
  } else {
    lines.push(
      `localIP = ${toml(route.targetHost)}`,
      `localPort = ${route.targetPort}`,
    );
  }
  return lines;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function toml(value: string): string {
  return JSON.stringify(value);
}

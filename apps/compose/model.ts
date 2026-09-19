import {
  isRecord,
  normalizeHostname,
  parseName,
  parsePort,
  type RouteProtocol,
  ValidationError,
} from "../../packages/api/mod.ts";
import { validateOrigin } from "../../packages/api/security.ts";

export interface ComposeRoute {
  host: string;
  name: string;
  protocol: RouteProtocol;
  hostname: string;
  targetHost: string;
  targetPort: number;
  allowPrivateNetwork: boolean;
}

export function routesFromCompose(value: unknown): ComposeRoute[] {
  if (!isRecord(value) || !isRecord(value.services)) {
    throw new ValidationError("invalid Compose model");
  }
  const routes: ComposeRoute[] = [];
  const project = typeof value.name === "string" ? value.name : "project";
  for (const [serviceName, rawService] of Object.entries(value.services)) {
    if (!isRecord(rawService) || !isRecord(rawService.labels)) continue;
    const labels = rawService.labels;
    const host = labels["dev.bunny-hole.host"];
    if (typeof host !== "string") continue;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(host)) {
      throw new ValidationError(`invalid Bunny Hole host on ${serviceName}`);
    }
    const protocol = String(
      labels["dev.bunny-hole.protocol"] ?? "http",
    ) as RouteProtocol;
    if (!new Set(["http", "https"]).has(protocol)) {
      throw new ValidationError(`invalid protocol label on ${serviceName}`);
    }
    const targetPort = parsePort(Number(labels["dev.bunny-hole.target-port"]));
    const targetHost = typeof labels["dev.bunny-hole.target-host"] === "string"
      ? labels["dev.bunny-hole.target-host"]
      : "127.0.0.1";
    const allowPrivateNetwork = labels["dev.bunny-hole.allow-private-network"] ===
      "true";
    const hostname = typeof labels["dev.bunny-hole.hostname"] === "string"
      ? labels["dev.bunny-hole.hostname"] as string
      : undefined;
    if (!hostname) {
      throw new ValidationError(
        `HTTP service ${serviceName} requires a hostname label`,
      );
    }
    const routeName = String(
      labels["dev.bunny-hole.name"] ?? `${project}-${serviceName}`,
    );
    const name = parseName(
      routeName.startsWith("compose-") ? routeName : `compose-${routeName}`,
    );
    validateOrigin(
      `${protocol}://${
        targetHost.includes(":") ? `[${targetHost}]` : targetHost
      }:${targetPort}`,
      allowPrivateNetwork,
    );
    routes.push({
      host,
      name,
      protocol,
      hostname: normalizeHostname(hostname),
      targetHost,
      targetPort,
      allowPrivateNetwork,
    });
  }
  return routes.sort((a, b) =>
    `${a.host}/${a.name}`.localeCompare(`${b.host}/${b.name}`)
  );
}

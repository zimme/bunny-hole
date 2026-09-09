import {
  isRecord,
  normalizeHostname,
  parsePort,
  type RouteProtocol,
  ValidationError,
} from "../../packages/api/mod.ts";

export interface DesiredRoute {
  hostRef: string;
  name: string;
  protocol: RouteProtocol;
  hostname: string;
  targetHost: string;
  targetPort: number;
  allowPrivateNetwork: true;
}

interface Listener {
  name: string;
  hostname?: string;
  namespaces: "same" | "all";
}

interface GatewayBinding {
  hostRef: string;
  namespace: string;
  name: string;
  listeners: Listener[];
}

/** Compiles the deliberately small, whole-hostname Gateway API profile. */
export function desiredRoutes(resources: unknown[]): DesiredRoute[] {
  const records = resources.filter(isRecord);
  const gateways = gatewayBindings(records);
  const output: DesiredRoute[] = [];
  for (const resource of records) {
    if (
      resource.kind !== "HTTPRoute" || !isRecord(resource.metadata) ||
      !isRecord(resource.spec) || typeof resource.metadata.name !== "string"
    ) continue;
    const namespace = namespaceOf(resource.metadata);
    const attachment = attachedGateway(records, gateways, resource.spec, namespace);
    if (!attachment) continue;
    const hostnames = Array.isArray(resource.spec.hostnames)
      ? resource.spec.hostnames.map(normalizeHostname)
      : [];
    if (hostnames.length === 0 || new Set(hostnames).size !== hostnames.length) {
      throw new ValidationError("HTTPRoute requires unique explicit hostnames");
    }
    for (const hostname of hostnames) {
      if (!listenerAllowsHostname(attachment.listener.hostname, hostname)) {
        throw new ValidationError("HTTPRoute hostname is outside its Gateway listener");
      }
    }
    const rules = Array.isArray(resource.spec.rules) ? resource.spec.rules : [];
    if (rules.length !== 1 || !isRecord(rules[0])) {
      throw new ValidationError("HTTPRoute requires exactly one rule");
    }
    const rule = rules[0];
    if (
      (Array.isArray(rule.matches) && rule.matches.length > 0) ||
      (Array.isArray(rule.filters) && rule.filters.length > 0) ||
      !Array.isArray(rule.backendRefs) || rule.backendRefs.length !== 1 ||
      !isRecord(rule.backendRefs[0])
    ) {
      throw new ValidationError(
        "HTTPRoute path matches, filters, and multiple backends are unsupported",
      );
    }
    const backend = rule.backendRefs[0];
    if (
      (backend.group !== undefined && backend.group !== "") ||
      (backend.kind !== undefined && backend.kind !== "Service") ||
      typeof backend.name !== "string" ||
      (backend.weight !== undefined && backend.weight !== 1)
    ) throw new ValidationError("HTTPRoute backend must be one Service");
    const targetNamespace = typeof backend.namespace === "string"
      ? backend.namespace
      : namespace;
    if (
      targetNamespace !== namespace &&
      !hasBackendGrant(records, namespace, targetNamespace, backend.name)
    ) throw new ValidationError("cross-namespace backend requires ReferenceGrant");
    const targetPort = parsePort(backend.port);
    for (const hostname of hostnames) {
      output.push({
        hostRef: attachment.gateway.hostRef,
        name: managedName(namespace, resource.metadata.name, hostname),
        protocol: "http",
        hostname,
        targetHost: `${backend.name}.${targetNamespace}.svc`,
        targetPort,
        allowPrivateNetwork: true,
      });
    }
  }
  return output.sort((a, b) =>
    `${a.hostRef}/${a.name}`.localeCompare(`${b.hostRef}/${b.name}`)
  );
}

function gatewayBindings(resources: Record<string, unknown>[]): GatewayBinding[] {
  const output: GatewayBinding[] = [];
  for (const resource of resources) {
    if (
      resource.kind !== "Gateway" || !isRecord(resource.metadata) ||
      !isRecord(resource.spec) || resource.spec.gatewayClassName !== "bunny-hole" ||
      typeof resource.metadata.name !== "string"
    ) continue;
    const namespace = namespaceOf(resource.metadata);
    const annotations = isRecord(resource.metadata.annotations)
      ? resource.metadata.annotations
      : {};
    const host = annotations["bunny-hole.dev/host"];
    if (typeof host !== "string") continue;
    const listeners = Array.isArray(resource.spec.listeners)
      ? resource.spec.listeners.flatMap(parseListener)
      : [];
    if (listeners.length === 0) {
      throw new ValidationError("Bunny Hole Gateway requires an HTTP listener");
    }
    output.push({
      hostRef: qualify(namespace, host),
      namespace,
      name: resource.metadata.name,
      listeners,
    });
  }
  return output;
}

function parseListener(value: unknown): Listener[] {
  if (!isRecord(value) || value.protocol !== "HTTP" || typeof value.name !== "string") {
    return [];
  }
  let namespaces: Listener["namespaces"] = "same";
  if (isRecord(value.allowedRoutes) && isRecord(value.allowedRoutes.namespaces)) {
    const from = value.allowedRoutes.namespaces.from ?? "Same";
    if (from === "All") namespaces = "all";
    else if (from !== "Same") {
      throw new ValidationError("Gateway namespace selectors are unsupported");
    }
  }
  return [{
    name: value.name,
    hostname: typeof value.hostname === "string"
      ? value.hostname.startsWith("*.")
        ? `*.${normalizeHostname(value.hostname.slice(2))}`
        : normalizeHostname(value.hostname)
      : undefined,
    namespaces,
  }];
}

function attachedGateway(
  resources: Record<string, unknown>[],
  gateways: GatewayBinding[],
  spec: Record<string, unknown>,
  routeNamespace: string,
): { gateway: GatewayBinding; listener: Listener } | undefined {
  const parents = Array.isArray(spec.parentRefs) ? spec.parentRefs : [];
  const matches: { gateway: GatewayBinding; listener: Listener }[] = [];
  for (const raw of parents) {
    if (
      !isRecord(raw) || typeof raw.name !== "string" ||
      (raw.group !== undefined && raw.group !== "gateway.networking.k8s.io") ||
      (raw.kind !== undefined && raw.kind !== "Gateway")
    ) continue;
    const gatewayNamespace = typeof raw.namespace === "string"
      ? raw.namespace
      : routeNamespace;
    const gateway = gateways.find((candidate) =>
      candidate.namespace === gatewayNamespace && candidate.name === raw.name
    );
    if (!gateway) continue;
    if (
      routeNamespace !== gatewayNamespace &&
      !hasParentGrant(resources, routeNamespace, gatewayNamespace, gateway.name)
    ) continue;
    for (const listener of gateway.listeners) {
      if (
        (raw.sectionName === undefined || raw.sectionName === listener.name) &&
        (listener.namespaces === "all" || routeNamespace === gatewayNamespace)
      ) matches.push({ gateway, listener });
    }
  }
  if (matches.length > 1) {
    throw new ValidationError(
      "HTTPRoute must attach to exactly one Bunny Hole listener",
    );
  }
  return matches[0];
}

function listenerAllowsHostname(
  listener: string | undefined,
  hostname: string,
): boolean {
  if (!listener) return true;
  if (!listener.startsWith("*.")) return listener === hostname;
  const suffix = listener.slice(2);
  const prefix = hostname.slice(0, -(suffix.length + 1));
  return hostname.endsWith(`.${suffix}`) && prefix.length > 0 && !prefix.includes(".");
}

function hasBackendGrant(
  resources: Record<string, unknown>[],
  fromNamespace: string,
  toNamespace: string,
  service: string,
): boolean {
  return hasGrant(
    resources,
    fromNamespace,
    toNamespace,
    "HTTPRoute",
    "",
    "Service",
    service,
  );
}

function hasParentGrant(
  resources: Record<string, unknown>[],
  fromNamespace: string,
  toNamespace: string,
  gateway: string,
): boolean {
  return hasGrant(
    resources,
    fromNamespace,
    toNamespace,
    "HTTPRoute",
    "gateway.networking.k8s.io",
    "Gateway",
    gateway,
  );
}

function hasGrant(
  resources: Record<string, unknown>[],
  fromNamespace: string,
  toNamespace: string,
  fromKind: string,
  toGroup: string,
  toKind: string,
  toName: string,
): boolean {
  return resources.some((resource) => {
    if (
      resource.kind !== "ReferenceGrant" || !isRecord(resource.metadata) ||
      !isRecord(resource.spec) || namespaceOf(resource.metadata) !== toNamespace
    ) return false;
    const from = Array.isArray(resource.spec.from) ? resource.spec.from : [];
    const to = Array.isArray(resource.spec.to) ? resource.spec.to : [];
    return from.some((item) =>
      isRecord(item) && item.group === "gateway.networking.k8s.io" &&
      item.kind === fromKind && item.namespace === fromNamespace
    ) && to.some((item) =>
      isRecord(item) && item.group === toGroup && item.kind === toKind &&
      (item.name === undefined || item.name === toName)
    );
  });
}

function managedName(namespace: string, name: string, hostname: string): string {
  const source = `${namespace}-${name}-${hostname}`.toLowerCase().replaceAll(
    /[^a-z0-9-]/g,
    "-",
  );
  const hash = fnv1a64(`${namespace}/${name}/${hostname}`);
  return `k8s-${source.slice(0, 96)}-${hash}`;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function namespaceOf(metadata: Record<string, unknown>): string {
  return typeof metadata.namespace === "string" ? metadata.namespace : "default";
}

function qualify(namespace: string, reference: string): string {
  return reference.includes("/") ? reference : `${namespace}/${reference}`;
}

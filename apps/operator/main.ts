import { join } from "node:path";
import {
  BunnyHoleClient,
  type HostCredentials,
  parseHostCredentials,
  type Session,
} from "../connector/client.ts";
import { runFrpc } from "../connector/frpc.ts";
import { createLogger } from "../../packages/api/logger.ts";
import type { Route } from "../../packages/api/mod.ts";
import { isRecord, ValidationError } from "../../packages/api/mod.ts";
import { type DesiredRoute, desiredRoutes } from "./model.ts";

interface HostResource {
  reference: string;
  url: string;
  secretName: string;
  transport: "quic" | "tcp" | "websocket" | "wss";
}

export async function runOperator(signal: AbortSignal): Promise<void> {
  const logger = createLogger("json");
  const kube = await KubernetesClient.create();
  const credentialsNamespace = Deno.env.get("BUNNY_HOLE_CREDENTIALS_NAMESPACE") ??
    "bunny-hole-system";
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(credentialsNamespace)) {
    throw new ValidationError("invalid credentials namespace");
  }
  const supervisors = new Map<
    string,
    { fingerprint: string; controller: AbortController }
  >();
  while (!signal.aborted) {
    try {
      const resources = await kube.gatewayResources();
      const routes = desiredRoutes(resources);
      const hosts = hostResources(resources);
      for (const host of hosts) {
        try {
          const credentials = await kube.credentials(
            credentialsNamespace,
            host.secretName,
          );
          const desired = routes.filter((route) => route.hostRef === host.reference);
          const session = await reconcileHost(host, credentials, desired);
          const fingerprint = JSON.stringify({
            enrollmentId: credentials.enrollmentId,
            routes: session.routes.map((route) => route.id).sort(),
          });
          const current = supervisors.get(host.reference);
          if (current?.fingerprint !== fingerprint) {
            current?.controller.abort();
            const controller = new AbortController();
            const supervisor = { fingerprint, controller };
            supervisors.set(host.reference, supervisor);
            runFrpc({
              executable: Deno.env.get("BUNNY_HOLE_FRPC_PATH") ??
                "/usr/local/bin/frpc",
              session,
              transport: host.transport,
              signal: controller.signal,
            }).then((code) => {
              if (supervisors.get(host.reference) === supervisor) {
                supervisors.delete(host.reference);
              }
              logger.warn("operator_connector_stopped", { host: host.reference, code });
            }).catch((error) => {
              if (supervisors.get(host.reference) === supervisor) {
                supervisors.delete(host.reference);
              }
              logger.error("operator_connector_failed", {
                host: host.reference,
                message: error instanceof Error ? error.message : "unknown error",
              });
            });
          }
          logger.info("operator_reconciled", {
            host: host.reference,
            routes: desired.length,
          });
        } catch (error) {
          supervisors.get(host.reference)?.controller.abort();
          supervisors.delete(host.reference);
          logger.error("operator_host_failed", {
            host: host.reference,
            message: error instanceof Error ? error.message : "unknown error",
          });
        }
      }
      for (const [reference, supervisor] of supervisors) {
        if (!hosts.some((host) => host.reference === reference)) {
          supervisor.controller.abort();
          supervisors.delete(reference);
        }
      }
    } catch (error) {
      for (const supervisor of supervisors.values()) supervisor.controller.abort();
      supervisors.clear();
      logger.error("operator_reconcile_failed", {
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
    await delay(15_000, signal);
  }
  for (const supervisor of supervisors.values()) supervisor.controller.abort();
}

async function reconcileHost(
  host: HostResource,
  credentials: HostCredentials,
  desired: DesiredRoute[],
): Promise<Session> {
  const client = new BunnyHoleClient(host.url);
  if (credentials.url !== client.url.href) {
    throw new ValidationError("host URL and credential disagree");
  }
  let session = await client.session(credentials);
  const desiredNames = new Set(desired.map((route) => route.name));
  for (const route of session.routes) {
    if (route.name.startsWith("k8s-") && !desiredNames.has(route.name)) {
      await client.deleteRoute(session, route.id);
    }
  }
  for (const route of desired) {
    const existing = session.routes.find((item) => item.name === route.name);
    if (existing && sameRoute(existing, route)) continue;
    if (existing) await client.deleteRoute(session, existing.id);
    await client.createRoute(session, route);
  }
  session = await client.session(credentials);
  return session;
}

function sameRoute(route: Route, desired: DesiredRoute): boolean {
  return route.protocol === desired.protocol && route.hostname === desired.hostname &&
    route.targetHost === desired.targetHost &&
    route.targetPort === desired.targetPort &&
    route.allowPrivateNetwork === desired.allowPrivateNetwork;
}

function hostResources(resources: unknown[]): HostResource[] {
  const output: HostResource[] = [];
  for (const value of resources) {
    if (
      !isRecord(value) || value.kind !== "BunnyHoleHost" || !isRecord(value.metadata) ||
      !isRecord(value.spec)
    ) continue;
    const namespace = typeof value.metadata.namespace === "string"
      ? value.metadata.namespace
      : "default";
    if (
      typeof value.metadata.name !== "string" || typeof value.spec.url !== "string" ||
      !isRecord(value.spec.credentialsSecretRef) ||
      typeof value.spec.credentialsSecretRef.name !== "string"
    ) continue;
    const transport = value.spec.transport ?? "wss";
    if (transport !== "wss") continue;
    output.push({
      reference: `${namespace}/${value.metadata.name}`,
      url: value.spec.url,
      secretName: value.spec.credentialsSecretRef.name,
      transport: transport as HostResource["transport"],
    });
  }
  return output;
}

class KubernetesClient {
  private constructor(
    private base: URL,
    private token: string,
    private client: Deno.HttpClient,
  ) {}

  static async create(): Promise<KubernetesClient> {
    const host = Deno.env.get("KUBERNETES_SERVICE_HOST");
    const port = Deno.env.get("KUBERNETES_SERVICE_PORT_HTTPS") ?? "443";
    if (!host) {
      throw new ValidationError("Kubernetes service environment is unavailable");
    }
    const directory = "/var/run/secrets/kubernetes.io/serviceaccount";
    const token = (await Deno.readTextFile(join(directory, "token"))).trim();
    const ca = await Deno.readTextFile(join(directory, "ca.crt"));
    return new KubernetesClient(
      new URL(`https://${formatHost(host)}:${port}`),
      token,
      Deno.createHttpClient({ caCerts: [ca] }),
    );
  }

  async gatewayResources(): Promise<unknown[]> {
    const paths = [
      "/apis/bunny-hole.dev/v1alpha1/bunnyholehosts",
      "/apis/gateway.networking.k8s.io/v1/gateways",
      "/apis/gateway.networking.k8s.io/v1/httproutes",
      "/apis/gateway.networking.k8s.io/v1beta1/referencegrants",
    ];
    return (await Promise.all(paths.map((path) => this.list(path)))).flat();
  }

  async credentials(namespace: string, name: string): Promise<HostCredentials> {
    const value = await this.request(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${
        encodeURIComponent(name)
      }`,
    );
    if (
      !isRecord(value) || !isRecord(value.data) ||
      typeof value.data["config.json"] !== "string"
    ) {
      throw new ValidationError("credential Secret requires data.config.json");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(atob(value.data["config.json"]));
      return parseHostCredentials(decoded);
    } catch {
      throw new ValidationError("invalid host credential Secret");
    }
  }

  private async list(path: string): Promise<unknown[]> {
    const response = await this.raw(path);
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Kubernetes list failed (${response.status})`);
    const value: unknown = await response.json();
    return isRecord(value) && Array.isArray(value.items) ? value.items : [];
  }

  private async request(path: string): Promise<unknown> {
    const response = await this.raw(path);
    if (!response.ok) throw new Error(`Kubernetes request failed (${response.status})`);
    return await response.json();
  }

  private raw(path: string): Promise<Response> {
    return fetch(new URL(path, this.base), {
      client: this.client,
      headers: { authorization: `Bearer ${this.token}` },
    });
  }
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  await runOperator(controller.signal);
}

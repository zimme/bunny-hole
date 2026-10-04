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
import { compileRoutes, type DesiredRoute } from "./model.ts";

interface HostResource {
  reference: string;
  url: string;
  secretName: string;
  transport: "quic" | "tcp" | "websocket" | "wss";
}

interface SupervisorState {
  fingerprint: string;
  controller: AbortController;
  done: Promise<void>;
}

export function connectorFingerprint(
  enrollmentId: string,
  routes: Iterable<Pick<Route, "id">>,
): string {
  return JSON.stringify({
    enrollmentId,
    routes: [...routes].map((route) => route.id).sort(),
  });
}

export function shouldRestartConnector(
  current: Pick<SupervisorState, "fingerprint"> | undefined,
  fingerprint: string,
  _now?: number,
): boolean {
  return current?.fingerprint !== fingerprint;
}

export async function runOperator(signal: AbortSignal): Promise<void> {
  const logger = createLogger("json");
  const credentialsNamespace = Deno.env.get("BUNNY_HOLE_CREDENTIALS_NAMESPACE") ??
    "bunny-hole-system";
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(credentialsNamespace)) {
    throw new ValidationError("invalid credentials namespace");
  }
  const kube = await KubernetesClient.create(signal);
  const supervisors = new Map<
    string,
    SupervisorState
  >();
  try {
    while (!signal.aborted) {
      try {
        const resources = await kube.gatewayResources();
        const compiled = compileRoutes(resources);
        const routes = compiled.routes;
        const hosts = hostResources(resources, credentialsNamespace);
        for (const error of compiled.errors) {
          logger.warn("operator_resource_rejected", { reason: error });
        }
        for (const host of hosts) {
          try {
            if (compiled.blockedHosts.has(host.reference)) {
              throw new ValidationError("host has invalid route policy");
            }
            const credentials = await kube.credentials(
              credentialsNamespace,
              host.secretName,
            );
            const desired = routes.filter((route) => route.hostRef === host.reference);
            const session = await reconcileHost(host, credentials, desired);
            const fingerprint = connectorFingerprint(
              credentials.enrollmentId,
              session.routes,
            );
            const current = supervisors.get(host.reference);
            if (shouldRestartConnector(current, fingerprint, Date.now())) {
              current?.controller.abort();
              await current?.done;
              const controller = new AbortController();
              const supervisor = {
                fingerprint,
                controller,
                done: Promise.resolve(),
              };
              supervisors.set(host.reference, supervisor);
              supervisor.done = runFrpc({
                executable: Deno.env.get("BUNNY_HOLE_FRPC_PATH") ??
                  "/usr/local/bin/frpc",
                session,
                transport: host.transport,
                signal: controller.signal,
              }).then((code) => {
                if (supervisors.get(host.reference) === supervisor) {
                  supervisors.delete(host.reference);
                }
                logger.warn("operator_connector_stopped", {
                  host: host.reference,
                  code,
                });
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
            const failed = supervisors.get(host.reference);
            failed?.controller.abort();
            await failed?.done;
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
            await supervisor.done;
            supervisors.delete(reference);
          }
        }
      } catch (error) {
        for (const supervisor of supervisors.values()) supervisor.controller.abort();
        await Promise.allSettled([...supervisors.values()].map((item) => item.done));
        supervisors.clear();
        logger.error("operator_reconcile_failed", {
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
      await delay(15_000, signal);
    }
  } finally {
    for (const supervisor of supervisors.values()) supervisor.controller.abort();
    await Promise.allSettled([...supervisors.values()].map((item) => item.done));
    kube.close();
  }
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

export function hostResources(
  resources: unknown[],
  credentialsNamespace: string,
): HostResource[] {
  const output: HostResource[] = [];
  for (const value of resources) {
    if (
      !isRecord(value) || value.kind !== "BunnyHoleHost" || !isRecord(value.metadata) ||
      !isRecord(value.spec)
    ) continue;
    const namespace = typeof value.metadata.namespace === "string"
      ? value.metadata.namespace
      : "default";
    if (namespace !== credentialsNamespace) continue;
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

export class KubernetesClient {
  constructor(
    private base: URL,
    private tokenPath: string,
    private client: Deno.HttpClient,
    private fetcher: typeof fetch = fetch,
    private signal?: AbortSignal,
  ) {}

  close(): void {
    this.client.close();
  }

  static async create(signal?: AbortSignal): Promise<KubernetesClient> {
    const host = Deno.env.get("KUBERNETES_SERVICE_HOST");
    const port = Deno.env.get("KUBERNETES_SERVICE_PORT_HTTPS") ?? "443";
    if (!host) {
      throw new ValidationError("Kubernetes service environment is unavailable");
    }
    const directory = "/var/run/secrets/kubernetes.io/serviceaccount";
    const tokenPath = join(directory, "token");
    const ca = await Deno.readTextFile(join(directory, "ca.crt"));
    return new KubernetesClient(
      new URL(`https://${formatHost(host)}:${port}`),
      tokenPath,
      Deno.createHttpClient({ caCerts: [ca] }),
      fetch,
      signal,
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

  private async raw(path: string): Promise<Response> {
    const token = (await Deno.readTextFile(this.tokenPath)).trim();
    if (!token) throw new ValidationError("service account token unavailable");
    return this.fetcher(new URL(path, this.base), {
      client: this.client,
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}` },
    });
  }
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  await runOperator(controller.signal);
}

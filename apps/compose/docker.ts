import { get, type IncomingMessage } from "node:http";
import { get as getHttps } from "node:https";
import { isRecord, ValidationError } from "../../packages/api/mod.ts";
import { type ComposeRoute, routesFromCompose } from "./model.ts";

export function validateProject(project: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) {
    throw new ValidationError("invalid Compose project name");
  }
}

export function routesFromContainers(value: unknown, project: string): ComposeRoute[] {
  validateProject(project);
  if (!Array.isArray(value) || value.length > 1024) {
    throw new ValidationError("invalid Docker container list");
  }
  const services: Record<string, { labels: Record<string, string> }> = Object.create(
    null,
  );
  for (const container of value) {
    if (!isRecord(container) || !isRecord(container.Labels)) {
      throw new ValidationError("invalid Docker container labels");
    }
    const labels = container.Labels;
    if (
      labels["com.docker.compose.project"] !== project ||
      container.State !== "running" ||
      // cspell:ignore oneoff -- Docker's canonical Compose label.
      String(labels["com.docker.compose.oneoff"]).toLowerCase() === "true"
    ) continue;
    if (typeof labels["dev.bunny-hole.host"] !== "string") continue;
    const service = labels["com.docker.compose.service"];
    if (typeof service !== "string" || !service) {
      throw new ValidationError("missing Compose service label");
    }
    const declaration: Record<string, string> = {};
    for (
      const name of Object.keys(labels).filter((name) =>
        name.startsWith("dev.bunny-hole.")
      ).sort()
    ) {
      if (typeof labels[name] !== "string") {
        throw new ValidationError("invalid Docker route label");
      }
      declaration[name] = labels[name];
    }
    declaration["dev.bunny-hole.target-host"] ??= service;
    const previous = services[service];
    if (previous && JSON.stringify(previous.labels) !== JSON.stringify(declaration)) {
      throw new ValidationError("conflicting Compose service replicas");
    }
    services[service] = { labels: declaration };
  }
  const routes = routesFromCompose({ name: project, services });
  const names = new Set<string>();
  const hostnames = new Set<string>();
  for (const route of routes) {
    const name = `${route.host}/${route.name}`;
    if (names.has(name) || hostnames.has(route.hostname)) {
      throw new ValidationError("duplicate Compose route name or hostname");
    }
    names.add(name);
    hostnames.add(route.hostname);
  }
  return routes;
}

export async function dockerContainers(
  project: string,
  signal: AbortSignal,
  endpoint = Deno.env.get("DOCKER_HOST") ?? "unix:///var/run/docker.sock",
): Promise<unknown> {
  validateProject(project);
  const url = new URL(endpoint);
  if (
    url.username || url.password || url.search || url.hash ||
    !["unix:", "http:", "https:", "tcp:"].includes(url.protocol) ||
    (url.protocol === "unix:"
      ? !!url.host || !url.pathname.startsWith("/")
      : !["", "/"].includes(url.pathname))
  ) {
    throw new ValidationError("invalid Docker API endpoint");
  }
  const socketPath = url.protocol === "unix:"
    ? decodeURIComponent(url.pathname)
    : undefined;
  const base = socketPath
    ? new URL("http://localhost")
    : new URL(endpoint.replace(/^tcp:/, "http:"));
  base.pathname = "/v1.44/containers/json";
  base.searchParams.set(
    "filters",
    JSON.stringify({ label: [`com.docker.compose.project=${project}`] }),
  );
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = (base.protocol === "https:" ? getHttps : get)(base, {
      socketPath,
      agent: false,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    }, resolve);
    request.once("error", reject);
  });
  try {
    if (response.statusCode !== 200) {
      throw new ValidationError("Docker container discovery failed");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        throw new ValidationError("Docker container list exceeds 4 MiB");
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ValidationError("invalid Docker container list JSON");
    }
  } finally {
    response.destroy();
  }
}

import { BunnyHoleClient } from "../connector/client.ts";
import { superviseConnector } from "../connector/supervisor.ts";
import { loadState, selectHost } from "../connector/state.ts";
import { routesFromCompose } from "./model.ts";
import { ValidationError } from "../../packages/api/mod.ts";
import type { Route } from "../../packages/api/mod.ts";
import type { ComposeRoute } from "./model.ts";

export async function runCompose(
  command: "plan" | "sync" | "up",
  configPath: string,
  signal: AbortSignal,
  effects: {
    run?: typeof run;
    capture?: typeof capture;
    client?: (url: string, development: boolean) => BunnyHoleClient;
    supervise?: typeof superviseConnector;
  } = {},
): Promise<void> {
  const executable = Deno.env.get("BUNNY_HOLE_COMPOSE_COMMAND") ?? "docker";
  const prefix = executable === "docker" ? ["compose"] : [];
  if (command === "up") {
    await (effects.run ?? run)(executable, [
      ...prefix,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "120",
    ]);
  }
  const output = await (effects.capture ?? capture)(executable, [
    ...prefix,
    "config",
    "--format",
    "json",
  ]);
  const desired = routesFromCompose(JSON.parse(output));
  if (command === "plan") {
    console.log(JSON.stringify({ routes: desired }, null, 2));
    return;
  }
  const state = await loadState(configPath);
  for (const hostName of new Set(desired.map((route) => route.host))) {
    if (!state.hosts[hostName]) {
      throw new ValidationError(`host ${hostName} is not configured`);
    }
  }
  const sessions = [];
  for (const hostName of Object.keys(state.hosts)) {
    const [, credentials] = selectHost(state, hostName);
    const client = (effects.client ?? ((url, development) =>
      new BunnyHoleClient(url, fetch, development)))(
        credentials.url,
        Deno.env.get("BUNNY_HOLE_DEVELOPMENT") === "true",
      );
    const hostRoutes = desired.filter((route) =>
      route.host === hostName
    );
    const session = await reconcileComposeHost(client, credentials, hostRoutes, signal);
    if (hostRoutes.length > 0) {
      sessions.push({ hostName, session, client, credentials });
    }
  }
  if (command === "sync") return;
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const tasks = sessions.map(async ({ session, client, credentials }) => {
    await (effects.supervise ?? superviseConnector)({
      client,
      credentials,
      signal: combined,
      executable: Deno.env.get("BUNNY_HOLE_FRPC_PATH") ?? "frpc",
      transport: session.descriptor.connectorTransports[0] ?? "wss",
      allowInsecureTransport: Deno.env.get("BUNNY_HOLE_DEVELOPMENT") === "true",
    });
  });
  try {
    await Promise.all(tasks);
  } finally {
    controller.abort();
    await Promise.allSettled(tasks);
  }
}

export async function reconcileComposeHost(
  client: BunnyHoleClient,
  credentials: import("../connector/client.ts").HostCredentials,
  desired: ComposeRoute[],
  signal?: AbortSignal,
): Promise<import("../connector/client.ts").Session> {
  const session = await client.session(credentials, signal);
  const names = new Set(desired.map((route) => route.name));
  for (const existing of session.routes) {
    if (existing.name.startsWith("compose-") && !names.has(existing.name)) {
      await client.deleteRoute(session, existing.id, signal);
    }
  }
  for (const route of desired) {
    const existing = session.routes.find((item) => item.name === route.name);
    if (existing && sameRoute(existing, route)) continue;
    if (existing) await client.deleteRoute(session, existing.id, signal);
    const { host: _host, ...body } = route;
    await client.createRoute(session, body, signal);
  }
  return desired.length > 0 ? await client.session(credentials, signal) : session;
}

function sameRoute(route: Route, desired: ComposeRoute): boolean {
  return route.protocol === desired.protocol && route.hostname === desired.hostname &&
    route.targetHost === desired.targetHost &&
    route.targetPort === desired.targetPort &&
    route.allowPrivateNetwork === desired.allowPrivateNetwork;
}

async function run(command: string, args: string[]): Promise<void> {
  const status = await new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`${command} failed (${status.code})`);
}

async function capture(command: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}

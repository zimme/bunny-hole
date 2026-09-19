import { BunnyHoleClient } from "../connector/client.ts";
import { runFrpc } from "../connector/frpc.ts";
import { loadState, selectHost } from "../connector/state.ts";
import { routesFromCompose } from "./model.ts";
import { ValidationError } from "../../packages/api/mod.ts";
import type { Route } from "../../packages/api/mod.ts";
import type { ComposeRoute } from "./model.ts";

export async function runCompose(
  command: "plan" | "sync" | "up",
  configPath: string,
  signal: AbortSignal,
): Promise<void> {
  const executable = Deno.env.get("BUNNY_HOLE_COMPOSE_COMMAND") ?? "docker";
  const prefix = executable === "docker" ? ["compose"] : [];
  if (command === "up") {
    await run(executable, [
      ...prefix,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "120",
    ]);
  }
  const output = await capture(executable, [...prefix, "config", "--format", "json"]);
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
    const client = new BunnyHoleClient(
      credentials.url,
      fetch,
      Deno.env.get("BUNNY_HOLE_LOCAL_DEVELOPMENT") === "true",
    );
    let session = await client.session(credentials);
    const hostRoutes = desired.filter((route) => route.host === hostName);
    const names = new Set(hostRoutes.map((route) => route.name));
    for (const existing of session.routes) {
      if (existing.name.startsWith("compose-") && !names.has(existing.name)) {
        await client.deleteRoute(session, existing.id);
      }
    }
    for (const route of hostRoutes) {
      const existing = session.routes.find((item) => item.name === route.name);
      if (existing && sameRoute(existing, route)) continue;
      if (existing) await client.deleteRoute(session, existing.id);
      await client.createRoute(session, route);
    }
    if (hostRoutes.length > 0) {
      session = await client.session(credentials);
      sessions.push({ hostName, session });
    }
  }
  if (command === "sync") return;
  await Promise.all(sessions.map(async ({ hostName, session }) => {
    const code = await runFrpc({
      executable: Deno.env.get("BUNNY_HOLE_FRPC_PATH") ?? "frpc",
      session,
      transport: session.descriptor.connectorTransports[0] ?? "wss",
      signal,
      allowInsecureTransport: Deno.env.get("BUNNY_HOLE_LOCAL_DEVELOPMENT") === "true",
    });
    if (!signal.aborted && code !== 0) {
      throw new ValidationError(`connector for ${hostName} stopped (${code})`);
    }
  }));
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

import {
  BunnyHoleClient,
  type HostCredentials,
  type Session,
} from "../connector/client.ts";
import type { Route } from "../../packages/api/mod.ts";
import type { ComposeRoute } from "./model.ts";

export async function reconcileComposeHost(
  client: BunnyHoleClient,
  credentials: HostCredentials,
  desired: ComposeRoute[],
  signal?: AbortSignal,
): Promise<Session> {
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

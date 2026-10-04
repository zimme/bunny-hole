import { BunnyHoleClient } from "../connector/client.ts";
import { abortableDelay } from "../connector/supervisor.ts";
import { runFrpc } from "../connector/frpc.ts";
import { loadState } from "../connector/state.ts";
import { ValidationError } from "../../packages/api/mod.ts";
import { reconcileComposeHost } from "./main.ts";
import { dockerContainers, routesFromContainers, validateProject } from "./docker.ts";

export async function serveCompose(
  project: string,
  configPath: string,
  signal: AbortSignal,
  effects: {
    containers?: typeof dockerContainers;
    client?: (url: string, development: boolean) => BunnyHoleClient;
    run?: typeof runFrpc;
    wait?: typeof abortableDelay;
  } = {},
): Promise<void> {
  validateProject(project);
  const children = new Map<
    string,
    { fingerprint: string; controller: AbortController; done: Promise<void> }
  >();
  const stopAll = async () => {
    for (const child of children.values()) child.controller.abort();
    await Promise.allSettled([...children.values()].map((child) => child.done));
    children.clear();
  };
  // Shutdown interrupts in-flight discovery/authentication as well as every owned child.
  const stop = () => {
    for (const child of children.values()) child.controller.abort();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (!signal.aborted) {
      try {
        const desired = routesFromContainers(
          await (effects.containers ?? dockerContainers)(project, signal),
          project,
        );
        const state = await loadState(configPath);
        const identities = new Set<string>();
        for (const credentials of Object.values(state.hosts)) {
          const identity =
            `${credentials.identityPublicKey}/${credentials.enrollmentId}`;
          if (identities.has(identity)) {
            throw new ValidationError("duplicate Compose connector enrollment");
          }
          identities.add(identity);
        }
        for (const route of desired) {
          if (!state.hosts[route.host]) {
            throw new ValidationError("Compose route host is not configured");
          }
        }
        // Validate all declarations before affecting any host.
        for (const [hostName, credentials] of Object.entries(state.hosts)) {
          const routes = desired.filter((route) => route.host === hostName);
          const client = (effects.client ?? ((url, development) =>
            new BunnyHoleClient(url, fetch, development)))(
              credentials.url,
              Deno.env.get("BUNNY_HOLE_DEVELOPMENT") === "true",
            );
          const session = await reconcileComposeHost(
            client,
            credentials,
            routes,
            signal,
          );
          const fingerprint = JSON.stringify({
            url: credentials.url,
            publicKey: credentials.publicKey,
            descriptor: session.descriptor,
            routes: [...session.routes].sort((a, b) =>
              a.id.localeCompare(b.id)
            ),
            enrollmentId: session.enrollmentId,
          });
          const current = children.get(hostName);
          if (routes.length === 0 || current?.fingerprint !== fingerprint) {
            current?.controller.abort();
            await current?.done;
            children.delete(hostName);
            if (routes.length > 0 && !signal.aborted) {
              const controller = new AbortController();
              const child = { fingerprint, controller, done: Promise.resolve() };
              children.set(hostName, child);
              child.done = (effects.run ?? runFrpc)({
                executable: Deno.env.get("BUNNY_HOLE_FRPC_PATH") ??
                  "/usr/local/bin/frpc",
                session,
                transport: session.descriptor.connectorTransports[0] ?? "wss",
                allowInsecureTransport:
                  Deno.env.get("BUNNY_HOLE_DEVELOPMENT") === "true",
                signal: AbortSignal.any([signal, controller.signal]),
              }).then(() => {
                if (children.get(hostName) === child) children.delete(hostName);
              }).catch(() => {
                if (children.get(hostName) === child) children.delete(hostName);
                console.error("Compose connector stopped; retrying");
              });
            }
          }
        }
        for (const [name, child] of children) {
          if (!state.hosts[name]) {
            child.controller.abort();
            await child.done;
            children.delete(name);
          }
        }
      } catch {
        await stopAll();
        if (!signal.aborted) console.error("Compose reconciliation failed; retrying");
      }
      await (effects.wait ?? abortableDelay)(5000, signal);
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await stopAll();
  }
}

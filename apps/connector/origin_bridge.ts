import { createServer, type Server } from "node:http";
import { request } from "node:https";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { Session } from "./client.ts";
import { validateOrigin } from "../../packages/api/security.ts";

/** FRP's HTTPS plugin disables verification. Keep TLS in Node's verified transport. */
export async function prepareOrigins(session: Session, caFile?: string): Promise<{
  session: Session;
  close(): Promise<void>;
}> {
  const servers: Server[] = [];
  const ca = caFile ? await readFile(caFile) : undefined;
  const close = async () => {
    await Promise.all(servers.map((server) =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      })
    ));
  };
  try {
    const routes = [];
    for (const route of session.routes) {
      if (route.protocol !== "https") {
        routes.push(route);
        continue;
      }
      const origin = validateOrigin(
        `https://${
          route.targetHost.includes(":") ? `[${route.targetHost}]` : route.targetHost
        }:${route.targetPort}`,
        route.allowPrivateNetwork,
      );
      const server = createServer((incoming, outgoing) => {
        const hostname = origin.hostname.replace(/^\[|\]$/g, "");
        const upstream = request({
          hostname,
          // HTTP Host is the public application hostname. TLS authenticates the
          // configured origin, independently of viewer-controlled request headers.
          servername: isIP(hostname) ? "" : hostname,
          checkServerIdentity: (_name, certificate) =>
            checkServerIdentity(hostname, certificate),
          port: route.targetPort,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
          ca,
          rejectUnauthorized: true,
        }, (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.rawHeaders);
          response.on("error", () => outgoing.destroy());
          response.pipe(outgoing);
        });
        const timer = setTimeout(
          () => upstream.destroy(new Error("origin timeout")),
          120_000,
        );
        const cleanup = () => {
          clearTimeout(timer);
          upstream.destroy();
        };
        incoming.on("aborted", cleanup);
        outgoing.on("close", cleanup);
        upstream.on("error", () => {
          clearTimeout(timer);
          if (outgoing.headersSent) outgoing.destroy();
          else {
            outgoing.writeHead(502);
            outgoing.end("origin unavailable\n");
          }
        });
        incoming.pipe(upstream);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      servers.push(server);
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("origin bridge unavailable");
      }
      routes.push({
        ...route,
        protocol: "http" as const,
        targetHost: "127.0.0.1",
        targetPort: address.port,
        allowPrivateNetwork: false,
      });
    }
    return { session: { ...session, routes }, close };
  } catch (error) {
    await close();
    throw error;
  }
}

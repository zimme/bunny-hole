import { Connector, ConnectorLogger } from "../apps/connector/connector.ts";
import { ConnectorConfig } from "../apps/connector/config.ts";
import { loadRelayConfig } from "../apps/relay/config.ts";
import { Relay } from "../apps/relay/relay.ts";
import { createSecret } from "../packages/protocol/auth.ts";
import { assert, assertEquals } from "./assert.ts";

const silentLogger = { info() {}, warn() {}, error() {} };

Deno.test({
  name:
    "relay and connector multiplex streaming requests with replacement and cancellation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const originPort = freePort();
    const relayPort = freePort();
    const secret = createSecret();
    const originAbort = new AbortController();
    const relayAbort = new AbortController();
    const origin = Deno.serve({
      hostname: "127.0.0.1",
      port: originPort,
      signal: originAbort.signal,
      onListen() {},
    }, async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/cancel") {
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                try {
                  controller.enqueue(new TextEncoder().encode("late"));
                  controller.close();
                } catch {
                  // Cancellation closed the stream.
                }
              }, 5_000);
            },
          }),
        );
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (url.pathname === "/binary") return new Response(bytes);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => headers[name] = value);
      return Response.json({
        path: url.pathname + url.search,
        body: new TextDecoder().decode(bytes),
        headers,
      });
    });

    const config = loadRelayConfig({
      HOST: "127.0.0.1",
      PORT: String(relayPort),
      BUNNY_HOLE_LOCAL_DEVELOPMENT: "true",
      BUNNY_HOLE_TUNNELS: JSON.stringify([{
        id: "integration",
        secret,
        hostnames: ["tunnel.test", "127.0.0.1"],
      }]),
    });
    const relay = new Relay(config, silentLogger);
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: relayPort,
      signal: relayAbort.signal,
      onListen() {},
    }, (request, info) => relay.handle(request, info));
    const connectorConfig: ConnectorConfig = {
      relayUrl: new URL(`ws://127.0.0.1:${relayPort}`),
      tunnelId: "integration",
      secret,
      origin: new URL(`http://127.0.0.1:${originPort}`),
      allowPrivateNetwork: false,
      localDevelopment: true,
      logFormat: "pretty",
    };
    const first = new Connector(connectorConfig, silentLogger);
    const firstAbort = new AbortController();
    const firstRun = first.run(firstAbort.signal);

    try {
      await waitUntil(() => relay.sessions.has("integration"));
      const bodies = Array.from(
        { length: 8 },
        (_, index) => `isolated-${index}-${"x".repeat(index * 100)}`,
      );
      const results = await Promise.all(bodies.map(async (body, index) => {
        const response = await publicFetch(relayPort, `/echo?id=${index}`, {
          method: "POST",
          headers: {
            "x-bunny-hole-secret": secret,
            "x-forwarded-for": "attacker",
          },
          body,
        });
        assertEquals(response.status, 200);
        return await response.json();
      }));
      assertEquals(results.map((result) => result.body), bodies);
      assert(
        results.every((result) =>
          result.headers["x-bunny-hole-secret"] === undefined &&
          result.headers["x-forwarded-for"] !== "attacker"
        ),
      );

      const bytes = crypto.getRandomValues(new Uint8Array(65_536));
      const binary = await publicFetch(relayPort, "/binary", {
        method: "POST",
        body: bytes,
      });
      assertEquals(
        [...new Uint8Array(await binary.arrayBuffer())],
        [...bytes],
      );

      let secondAuthenticated!: () => void;
      const authenticated = new Promise<void>((resolve) =>
        secondAuthenticated = resolve
      );
      const replacementLogger: ConnectorLogger = {
        info(event) {
          if (event === "connector_authenticated") secondAuthenticated();
        },
        warn() {},
        error() {},
      };
      const second = new Connector(connectorConfig, replacementLogger);
      const secondAbort = new AbortController();
      const secondRun = second.run(secondAbort.signal);
      await authenticated;
      firstAbort.abort();
      first.stop();
      await waitUntil(() => relay.sessions.get("integration") !== undefined);
      const replaced = await publicFetch(relayPort, "/after-replacement");
      assertEquals(replaced.status, 200);

      const disconnected = await Deno.connect({
        hostname: "127.0.0.1",
        port: relayPort,
      });
      await disconnected.write(
        new TextEncoder().encode(
          "GET /cancel HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        ),
      );
      await waitUntil(() => relay.pending.size === 1);
      const responsePrefix = new Uint8Array(256);
      await disconnected.read(responsePrefix);
      disconnected.close();
      await waitUntil(() => relay.pending.size === 0);

      secondAbort.abort();
      second.stop();
      await secondRun;
    } finally {
      firstAbort.abort();
      first.stop();
      await firstRun;
      relay.shutdown();
      relayAbort.abort();
      originAbort.abort();
      await Promise.all([server.finished, origin.finished]);
    }
  },
});

function publicFetch(
  port: number,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

async function waitUntil(predicate: () => boolean, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

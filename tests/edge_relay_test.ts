import {
  createEdgeRelayHandler,
  edgeWebSocketUpgrader,
  loadEdgeRelayConfig,
} from "../apps/edge-relay/relay.ts";
import { generateTunnelKeyPair } from "../packages/protocol/auth.ts";
import { assertEquals } from "./assert.ts";

const token = "d".repeat(32);
const { publicKey } = await generateTunnelKeyPair();
const environment = new Map<string, string>([
  [
    "BUNNY_HOLE_TUNNELS",
    JSON.stringify([{
      id: "alpha",
      publicKey,
      hostnames: ["alpha.example"],
    }]),
  ],
  ["BUNNY_HOLE_EDGE_DIAGNOSTIC_TOKEN", token],
]);

function config() {
  return loadEdgeRelayConfig({ get: (name) => environment.get(name) });
}

Deno.test("edge diagnostics identify an isolate without exposing tunnel records", async () => {
  const relay = {
    sessions: new Map([["alpha", {}]]),
    pending: new Map([["request", {}]]),
    handle: () => Promise.resolve(new Response("proxied")),
  };
  const handler = createEdgeRelayHandler({
    config: config(),
    instanceId: "instance-one",
    startedAt: "2026-07-25T00:00:00.000Z",
    logger: { info() {}, warn() {}, error() {} },
    relay,
  });

  const unauthorized = await handler(
    new Request("https://alpha.example/_bunny/edge/diagnostics"),
  );
  assertEquals(unauthorized.status, 404);
  assertEquals(unauthorized.headers.get("cache-control"), "no-store");
  assertEquals(await unauthorized.json(), { error: "tunnel request failed" });

  const response = await handler(
    new Request("https://alpha.example/_bunny/edge/diagnostics", {
      headers: { "x-bunny-hole-diagnostic-token": token },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(response.headers.get("x-bunny-hole-edge-instance"), "instance-one");
  const body = await response.json();
  assertEquals(body.instanceId, "instance-one");
  assertEquals(body.authenticatedConnectors, 1);
  assertEquals(body.pendingRequests, 1);
  assertEquals(body.configuredTunnels, 1);
  assertEquals(
    JSON.stringify(body).includes(environment.get("BUNNY_HOLE_TUNNELS")!),
    false,
  );
});

Deno.test("edge experiment marks ordinary responses only while diagnostics are enabled", async () => {
  const relay = {
    sessions: new Map<string, unknown>(),
    pending: new Map<string, unknown>(),
    handle: () => Promise.resolve(new Response("proxied")),
  };
  const enabled = createEdgeRelayHandler({
    config: config(),
    instanceId: "instance-enabled",
    logger: { info() {}, warn() {}, error() {} },
    relay,
  });
  assertEquals(
    (await enabled(new Request("https://alpha.example/path"))).headers.get(
      "x-bunny-hole-edge-instance",
    ),
    "instance-enabled",
  );

  environment.delete("BUNNY_HOLE_EDGE_DIAGNOSTIC_TOKEN");
  const disabled = createEdgeRelayHandler({
    config: config(),
    instanceId: "instance-disabled",
    logger: { info() {}, warn() {}, error() {} },
    relay,
  });
  assertEquals(
    (await disabled(new Request("https://alpha.example/path"))).headers.get(
      "x-bunny-hole-edge-instance",
    ),
    null,
  );
  environment.set("BUNNY_HOLE_EDGE_DIAGNOSTIC_TOKEN", token);
});

Deno.test("edge WebSocket adapter uses Bunny protocol and idle options", () => {
  let received: unknown;
  const expected = {
    socket: {} as WebSocket,
    response: new Response(null, { status: 200 }),
  };
  const request = new Request("https://alpha.example/_bunny/connect");
  Object.defineProperty(request, "upgradeWebSocket", {
    value(options: unknown) {
      received = options;
      return expected;
    },
  });
  assertEquals(edgeWebSocketUpgrader(request, "bunny-hole.v1"), expected);
  assertEquals(received, { protocol: "bunny-hole.v1", idleTimeout: 60 });
});

Deno.test("edge diagnostics require a strong bounded token", () => {
  environment.set("BUNNY_HOLE_EDGE_DIAGNOSTIC_TOKEN", "short");
  let message = "";
  try {
    config();
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assertEquals(message.includes("32-512"), true);
  environment.set("BUNNY_HOLE_EDGE_DIAGNOSTIC_TOKEN", token);
});

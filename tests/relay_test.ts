import { createSecret } from "../packages/protocol/auth.ts";
import { loadRelayConfig } from "../apps/relay/config.ts";
import { Relay } from "../apps/relay/relay.ts";
import {
  decodeFrame,
  FrameType,
  LIMITS,
  SUBPROTOCOL,
} from "../packages/protocol/mod.ts";
import { assert, assertEquals } from "./assert.ts";

const logger = { info() {}, warn() {}, error() {} };
const config = loadRelayConfig({
  BUNNY_HOLE_LOCAL_DEVELOPMENT: "true",
  BUNNY_HOLE_TUNNELS: JSON.stringify([{
    id: "alpha",
    secret: createSecret(),
    hostnames: ["alpha.example"],
  }]),
});

Deno.test("health and readiness transition during graceful shutdown", async () => {
  const relay = new Relay(config, logger);
  assertEquals((await relay.handle(new Request("http://relay/healthz"))).status, 200);
  assertEquals((await relay.handle(new Request("http://relay/readyz"))).status, 200);
  relay.shutdown();
  assertEquals((await relay.handle(new Request("http://relay/healthz"))).status, 200);
  assertEquals((await relay.handle(new Request("http://relay/readyz"))).status, 503);
});

Deno.test("public requests route only by configured hostname", async () => {
  const relay = new Relay(config, logger);
  const unknown = await relay.handle(
    new Request("http://relay/path", { headers: { host: "other.example" } }),
  );
  assertEquals(unknown.status, 404);
  const offline = await relay.handle(
    new Request("http://relay/path", { headers: { host: "alpha.example" } }),
  );
  assertEquals(offline.status, 503);
  const confused = await relay.handle(
    new Request("http://relay/path", {
      headers: { host: "alpha.example.evil.example" },
    }),
  );
  assertEquals(confused.status, 404);
});

Deno.test("connector control endpoint requires a WebSocket GET", async () => {
  const relay = new Relay(config, logger);
  assertEquals(
    (await relay.handle(new Request("http://relay/_bunny/connect?id=unknown"))).status,
    400,
  );
  assertEquals(
    (await relay.handle(
      new Request("http://relay/_bunny/connect?id=alpha", { method: "POST" }),
    )).status,
    405,
  );
});

Deno.test("connector upgrade does not disclose configured tunnel IDs", async () => {
  const upgraded: string[] = [];
  const sockets: WebSocket[] = [];
  const relay = new Relay(
    config,
    logger,
    Date.now,
    (request, protocol) => {
      upgraded.push(`${new URL(request.url).searchParams.get("id")}:${protocol}`);
      const socket = {
        binaryType: "",
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        send() {},
        close() {},
      } as unknown as WebSocket;
      sockets.push(socket);
      return { socket, response: new Response(null, { status: 200 }) };
    },
  );
  const headers = {
    upgrade: "websocket",
    "sec-websocket-protocol": SUBPROTOCOL,
  };
  const known = await relay.handle(
    new Request("http://relay/_bunny/connect?id=alpha", { headers }),
  );
  const unknown = await relay.handle(
    new Request("http://relay/_bunny/connect?id=unknown", { headers }),
  );
  const confused = await relay.handle(
    new Request("http://relay/_bunny/connect?id=alpha&extra=true", { headers }),
  );
  assertEquals(known.status, 200);
  assertEquals(unknown.status, known.status);
  assertEquals(confused.status, 400);
  assertEquals(upgraded, [`alpha:${SUBPROTOCOL}`, `unknown:${SUBPROTOCOL}`]);
  for (const socket of sockets) socket.onclose?.(new CloseEvent("close"));
});

Deno.test("relay failure cancels connector work and clears request state", async () => {
  const sent: Uint8Array[] = [];
  const socket = {
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(frame);
    },
    close() {},
  } as unknown as WebSocket;
  const relay = relayWithSessionForTest(config, socket);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(LIMITS.maxBodyBytes + 1));
      controller.close();
    },
  });
  const response = await relay.handle(
    new Request("http://relay/oversized", {
      method: "POST",
      headers: { host: "alpha.example" },
      body,
      // Required by Node's Fetch implementation and ignored by Deno.
      duplex: "half",
    } as RequestInit),
  );
  await Promise.resolve();
  assertEquals(response.status, 413);
  assertEquals(relay.pending.size, 0);
  assert(
    sent.some((frame) => decodeFrame(frame).type === FrameType.cancel),
    "relay did not send a cancel frame",
  );
});

function relayWithSessionForTest(
  relayConfig: typeof config,
  socket: WebSocket,
): Relay {
  const relay = new Relay(relayConfig, logger);
  relay.sessions.set("alpha", {
    tunnelId: "alpha",
    socket,
    authenticated: true,
    nonce: "test-nonce",
    lastSeen: Date.now(),
    requests: new Set(),
    heartbeatSending: false,
  });
  return relay;
}

import { createProof, createSecret } from "../packages/protocol/auth.ts";
import { loadRelayConfig } from "../apps/relay/config.ts";
import { Relay } from "../apps/relay/relay.ts";
import {
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  FrameType,
  LIMITS,
  PROTOCOL_VERSION,
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
  const ready = await relay.handle(new Request("http://relay/readyz"));
  assertEquals(ready.status, 200);
  assertEquals(ready.headers.get("cache-control"), "no-store");
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

Deno.test("shutdown closes connectors that are still authenticating", async () => {
  const closeCodes: number[] = [];
  const socket = {
    binaryType: "",
    bufferedAmount: 0,
    readyState: WebSocket.CONNECTING,
    send() {},
    close(code: number) {
      closeCodes.push(code);
    },
  } as unknown as WebSocket;
  const relay = new Relay(config, logger, Date.now, () => ({
    socket,
    response: new Response(null, { status: 200 }),
  }));
  const response = await relay.handle(
    new Request("http://relay/_bunny/connect?id=alpha", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": SUBPROTOCOL,
      },
    }),
  );
  assertEquals(response.status, 200);
  relay.shutdown();
  assertEquals(closeCodes, [4001]);
});

Deno.test("authentication challenge honors connection backpressure", async () => {
  const sent: Uint8Array[] = [];
  let bufferedAmount = LIMITS.maxBufferedAmount + 1;
  const socket = {
    binaryType: "",
    get bufferedAmount() {
      return bufferedAmount;
    },
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(frame);
    },
    close() {},
  } as unknown as WebSocket;
  const relay = new Relay(config, logger, Date.now, () => ({
    socket,
    response: new Response(null, { status: 200 }),
  }));
  const response = await relay.handle(
    new Request("http://relay/_bunny/connect?id=alpha", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": SUBPROTOCOL,
      },
    }),
  );

  assertEquals(response.status, 200);
  socket.onopen?.(new Event("open"));
  await Promise.resolve();
  assertEquals(sent.length, 0);

  bufferedAmount = 0;
  await waitUntil(() => sent.length === 1);
  assertEquals(decodeFrame(sent[0]).type, FrameType.challenge);
  relay.shutdown();
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

Deno.test("connector messages are serialized across authentication", async () => {
  const sent: Uint8Array[] = [];
  const closeCodes: number[] = [];
  const socket = {
    binaryType: "",
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(frame);
    },
    close(code: number) {
      closeCodes.push(code);
      queueMicrotask(() => socket.onclose?.(new CloseEvent("close", { code })));
    },
  } as unknown as WebSocket;
  const relay = new Relay(config, logger, Date.now, () => ({
    socket,
    response: new Response(null, { status: 200 }),
  }));
  const request = new Request("http://relay/_bunny/connect?id=alpha", {
    headers: {
      upgrade: "websocket",
      "sec-websocket-protocol": SUBPROTOCOL,
    },
  });
  assertEquals((await relay.handle(request)).status, 200);
  socket.onopen?.(new Event("open"));
  const challenge = decodeControl(decodeFrame(sent[0]).payload) as {
    nonce: string;
  };
  const proof = await createProof(
    config.tunnels.get("alpha")!.secret,
    "alpha",
    challenge.nonce,
    PROTOCOL_VERSION,
  );
  const authenticate = encodeFrame(
    FrameType.authenticate,
    "",
    encodeControl({ version: PROTOCOL_VERSION, proof }),
  );
  const event = new MessageEvent("message", {
    data: authenticate.buffer as ArrayBuffer,
  });
  socket.onmessage?.(event);
  socket.onmessage?.(event);
  await waitUntil(() => closeCodes.length > 0);
  assertEquals(relay.sessions.has("alpha"), false);
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

Deno.test("relay splits a large public stream chunk into bounded request frames", async () => {
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
      controller.enqueue(
        new Uint8Array(LIMITS.maxFrameBytes * 2 + 17),
      );
      controller.close();
    },
  });
  const handled = relay.handle(
    new Request("http://relay/large-chunk", {
      method: "POST",
      headers: { host: "alpha.example" },
      body,
    }),
  );
  await waitUntil(() =>
    sent.some((bytes) => decodeFrame(bytes).type === FrameType.requestEnd)
  );
  const frames = sent.map(decodeFrame);
  const start = frames.find((frame) => frame.type === FrameType.requestStart)!;
  assertEquals(
    frames.filter((frame) => frame.type === FrameType.requestBody).map((frame) =>
      frame.payload.byteLength
    ),
    [LIMITS.maxFrameBytes, LIMITS.maxFrameBytes, 17],
  );

  const session = relay.sessions.get("alpha")!;
  const internal = relay as unknown as {
    handleAuthenticatedFrame(
      session: unknown,
      frame: ReturnType<typeof decodeFrame>,
    ): Promise<void>;
  };
  await internal.handleAuthenticatedFrame(
    session,
    decodeFrame(encodeFrame(
      FrameType.responseStart,
      start.id,
      encodeControl({ status: 204, headers: [] }),
    )),
  );
  await internal.handleAuthenticatedFrame(
    session,
    decodeFrame(encodeFrame(FrameType.responseEnd, start.id)),
  );
  assertEquals((await handled).status, 204);
});

Deno.test("GET and HEAD bodies cannot disconnect a tunnel", async () => {
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
  for (const method of ["GET", "HEAD"]) {
    const request = {
      url: "http://relay/body",
      method,
      headers: new Headers({ host: "alpha.example" }),
      body: new ReadableStream<Uint8Array>(),
    } as Request;
    assertEquals((await relay.handle(request)).status, 400);
  }
  assertEquals(sent.length, 0);
  assertEquals(relay.sessions.has("alpha"), true);
});

Deno.test("shutdown cancels a slow public request body", async () => {
  const socket = {
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send() {},
    close() {},
  } as unknown as WebSocket;
  const relay = relayWithSessionForTest(config, socket);
  let bodyCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      bodyCancelled = true;
    },
  });
  const handled = relay.handle(
    new Request("http://relay/slow-upload", {
      method: "POST",
      headers: { host: "alpha.example" },
      body,
    }),
  );
  await waitUntil(() => relay.pending.size === 1);
  relay.shutdown();
  const response = await handled;
  assertEquals(response.status, 503);
  assertEquals(bodyCancelled, true);
  assertEquals(relay.pending.size, 0);
});

Deno.test("viewer disconnect settles the handler and clears request state", async () => {
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
  const completed = Promise.withResolvers<void>();

  const handled = relay.handle(
    new Request("http://relay/disconnected", {
      headers: { host: "alpha.example" },
    }),
    { completed: completed.promise },
  );
  assertEquals(relay.pending.size, 1);

  completed.reject(new Error("viewer disconnected"));
  const response = await handled;

  assertEquals(response.status, 502);
  assertEquals(relay.pending.size, 0);
  assert(
    sent.some((frame) => decodeFrame(frame).type === FrameType.cancel),
    "relay did not cancel connector work after the viewer disconnected",
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
    messageQueue: Promise.resolve(),
    closed: false,
    cancelled: new Map(),
  });
  return relay;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}

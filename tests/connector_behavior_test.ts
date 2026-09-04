import { calculateBackoffDelay, Connector } from "../apps/connector/connector.ts";
import { createNonce, generateTunnelKeyPair } from "../packages/protocol/auth.ts";
import {
  decodeFrame,
  encodeControl,
  encodeFrame,
  Frame,
  FrameType,
  LIMITS,
  PROTOCOL_VERSION,
} from "../packages/protocol/mod.ts";
import { assertEquals, assertRejects } from "./assert.ts";

Deno.test("connector backoff jitter is bounded and deterministically injectable", () => {
  assertEquals(calculateBackoffDelay(500, () => 0), 400);
  assertEquals(calculateBackoffDelay(500, () => 200 / 201), 600);
  assertEquals(calculateBackoffDelay(30_000, () => 0), 24_000);
  assertEquals(calculateBackoffDelay(30_000, () => 12_000 / 12_001), 36_000);
});

Deno.test("connector validates in-flight request frames after local cancellation", async () => {
  const sent: Frame[] = [];
  const socket = {
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(decodeFrame(frame));
    },
  };
  const connector = new Connector({
    relayUrl: new URL("ws://127.0.0.1:8080"),
    tunnelId: "cancel-test",
    privateKey: "unused",
    origin: new URL("http://127.0.0.1:3000"),
  }, { info() {}, warn() {}, error() {} });
  const internal = connector as unknown as {
    socket: typeof socket;
    requests: Map<string, {
      id: string;
      abort: AbortController;
      ended: boolean;
      responseDone: boolean;
      requestBytes: number;
      timeout: ReturnType<typeof setTimeout>;
    }>;
    timeoutRequest(id: string): Promise<void>;
    handleFrame(frame: Frame): Promise<void>;
  };
  internal.socket = socket;
  internal.requests.set("abcdefghijklmnop", {
    id: "abcdefghijklmnop",
    abort: new AbortController(),
    ended: false,
    responseDone: false,
    requestBytes: 3,
    timeout: setTimeout(() => {}, 60_000),
  });

  await internal.timeoutRequest("abcdefghijklmnop");
  assertEquals(sent.map((frame) => frame.type), [FrameType.cancel]);
  await internal.handleFrame({
    type: FrameType.requestBody,
    id: "abcdefghijklmnop",
    payload: new Uint8Array([1, 2]),
  });
  await internal.handleFrame({
    type: FrameType.requestEnd,
    id: "abcdefghijklmnop",
    payload: new Uint8Array(),
  });
  await assertRejects(
    () =>
      internal.handleFrame({
        type: FrameType.requestEnd,
        id: "abcdefghijklmnop",
        payload: new Uint8Array(),
      }),
    /duplicate request end/,
  );
  await assertRejects(
    () =>
      internal.handleFrame({
        type: FrameType.requestBody,
        id: "unknown-request-id",
        payload: new Uint8Array(),
      }),
    /unknown request/,
  );
});

Deno.test("connector cleans up an origin failure before request upload ends", async () => {
  const sent: Frame[] = [];
  const socket = {
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(decodeFrame(frame));
    },
  };
  const connector = new Connector({
    relayUrl: new URL("ws://127.0.0.1:8080"),
    tunnelId: "origin-failure-test",
    privateKey: "unused",
    origin: new URL("http://127.0.0.1:3000"),
  }, { info() {}, warn() {}, error() {} });
  const request = {
    id: "abcdefghijklmnop",
    abort: new AbortController(),
    ended: false,
    responseDone: false,
    requestBytes: 0,
    timeout: setTimeout(() => {}, 60_000),
  };
  const internal = connector as unknown as {
    socket: typeof socket;
    requests: Map<string, typeof request>;
    proxyOrigin(
      context: typeof request,
      target: URL,
      method: string,
      headers: { name: string; value: string }[],
      body?: ReadableStream<Uint8Array>,
    ): Promise<void>;
    handleFrame(frame: Frame): Promise<void>;
    timeoutRequest(id: string): Promise<void>;
  };
  internal.socket = socket;
  internal.requests.set(request.id, request);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("origin unavailable"));
  try {
    await internal.proxyOrigin(
      request,
      new URL("http://127.0.0.1:3000/failure"),
      "POST",
      [],
      new ReadableStream(),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(request.abort.signal.aborted, true);
  assertEquals(internal.requests.has(request.id), false);
  assertEquals(sent.map((frame) => frame.type), [FrameType.cancel]);
  await internal.handleFrame({
    type: FrameType.requestBody,
    id: request.id,
    payload: new Uint8Array([1, 2, 3]),
  });
  await internal.handleFrame({
    type: FrameType.requestEnd,
    id: request.id,
    payload: new Uint8Array(),
  });
  await internal.timeoutRequest(request.id);
  assertEquals(sent.map((frame) => frame.type), [FrameType.cancel]);
});

Deno.test("connector retains an early origin response until request upload ends", async () => {
  const sent: Frame[] = [];
  const socket = {
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(decodeFrame(frame));
    },
  };
  type TestRequest = {
    id: string;
    abort: AbortController;
    ended: boolean;
    responseDone: boolean;
    requestBytes: number;
    timeout: ReturnType<typeof setTimeout>;
    controller?: ReadableStreamDefaultController<Uint8Array>;
  };
  const request: TestRequest = {
    id: "abcdefghijklmnop",
    abort: new AbortController(),
    ended: false,
    responseDone: false,
    requestBytes: 0,
    timeout: setTimeout(() => {}, 60_000),
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      request.controller = controller;
    },
  });
  const connector = new Connector({
    relayUrl: new URL("ws://127.0.0.1:8080"),
    tunnelId: "early-response-test",
    privateKey: "unused",
    origin: new URL("http://127.0.0.1:3000"),
  }, { info() {}, warn() {}, error() {} });
  const internal = connector as unknown as {
    socket: typeof socket;
    requests: Map<string, typeof request>;
    recent: Map<string, {
      kind: string;
      requestBytes: number;
      ended: boolean;
      expiresAt: number;
    }>;
    proxyOrigin(
      context: typeof request,
      target: URL,
      method: string,
      headers: { name: string; value: string }[],
      body: ReadableStream<Uint8Array>,
    ): Promise<void>;
    handleFrame(frame: Frame): Promise<void>;
  };
  internal.socket = socket;
  internal.requests.set(request.id, request);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 204 }));
  try {
    await internal.proxyOrigin(
      request,
      new URL("http://127.0.0.1:3000/early"),
      "POST",
      [],
      body,
    );
    assertEquals(request.responseDone, true);
    assertEquals(internal.requests.has(request.id), true);
    assertEquals(internal.recent.has(request.id), false);

    await internal.handleFrame({
      type: FrameType.requestBody,
      id: request.id,
      payload: new Uint8Array([1, 2, 3]),
    });
    await internal.handleFrame({
      type: FrameType.requestEnd,
      id: request.id,
      payload: new Uint8Array(),
    });
  } finally {
    globalThis.fetch = originalFetch;
    clearTimeout(request.timeout);
  }

  assertEquals(request.ended, true);
  assertEquals(request.requestBytes, 3);
  assertEquals(internal.requests.has(request.id), false);
  const recent = internal.recent.get(request.id);
  assertEquals(recent?.kind, "completed");
  assertEquals(recent?.requestBytes, 3);
  assertEquals(recent?.ended, true);
  assertEquals(sent.map((frame) => frame.type), [
    FrameType.responseStart,
    FrameType.responseEnd,
  ]);
});

Deno.test("relay cancellation aborts an origin response send under backpressure", async () => {
  const sendStarted = Promise.withResolvers<void>();
  const sent: Frame[] = [];
  const socket = {
    get bufferedAmount() {
      sendStarted.resolve();
      return LIMITS.maxBufferedAmount + 1;
    },
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(decodeFrame(frame));
    },
  };
  const connector = new Connector({
    relayUrl: new URL("ws://127.0.0.1:8080"),
    tunnelId: "response-cancel-test",
    privateKey: "unused",
    origin: new URL("http://127.0.0.1:3000"),
  }, { info() {}, warn() {}, error() {} });
  const request = {
    id: "abcdefghijklmnop",
    abort: new AbortController(),
    ended: true,
    responseDone: false,
    requestBytes: 0,
    timeout: setTimeout(() => {}, 60_000),
  };
  const internal = connector as unknown as {
    socket: typeof socket;
    requests: Map<string, typeof request>;
    proxyOrigin(
      context: typeof request,
      target: URL,
      method: string,
      headers: { name: string; value: string }[],
    ): Promise<void>;
    handleFrame(frame: Frame): Promise<void>;
  };
  internal.socket = socket;
  internal.requests.set(request.id, request);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("origin response"));
  try {
    const proxying = internal.proxyOrigin(
      request,
      new URL("http://127.0.0.1:3000/cancelled"),
      "GET",
      [],
    );
    await sendStarted.promise;
    await internal.handleFrame({
      type: FrameType.cancel,
      id: request.id,
      payload: new Uint8Array(),
    });
    await proxying;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(request.abort.signal.aborted, true);
  assertEquals(request.responseDone, true);
  assertEquals(internal.requests.has(request.id), false);
  assertEquals(sent, []);
});

Deno.test("connector splits a large origin stream chunk into bounded response frames", async () => {
  const sent: Frame[] = [];
  const socket = {
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(decodeFrame(frame));
    },
  };
  const connector = new Connector({
    relayUrl: new URL("ws://127.0.0.1:8080"),
    tunnelId: "chunk-test",
    privateKey: "unused",
    origin: new URL("http://127.0.0.1:3000"),
  }, { info() {}, warn() {}, error() {} });
  type TestContext = {
    id: string;
    abort: AbortController;
    ended: boolean;
    responseDone: boolean;
    requestBytes: number;
    timeout: ReturnType<typeof setTimeout>;
  };
  const context: TestContext = {
    id: "abcdefghijklmnop",
    abort: new AbortController(),
    ended: true,
    responseDone: false,
    requestBytes: 0,
    timeout: setTimeout(() => {}, 60_000),
  };
  const internal = connector as unknown as {
    socket: typeof socket;
    requests: Map<string, typeof context>;
    proxyOrigin(
      context: TestContext,
      target: URL,
      method: string,
      headers: { name: string; value: string }[],
      body?: ReadableStream<Uint8Array>,
    ): Promise<void>;
  };
  internal.socket = socket;
  internal.requests.set(context.id, context);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(LIMITS.maxFrameBytes * 2 + 17));
            controller.close();
          },
        }),
      ),
    );
  try {
    await internal.proxyOrigin(
      context,
      new URL("http://127.0.0.1:3000/large-chunk"),
      "GET",
      [],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(
    sent.filter((frame) => frame.type === FrameType.responseBody).map((frame) =>
      frame.payload.byteLength
    ),
    [LIMITS.maxFrameBytes, LIMITS.maxFrameBytes, 17],
  );
  assertEquals(sent.at(-1)?.type, FrameType.responseEnd);
});

Deno.test("connector rejects a duplicate authentication challenge", async () => {
  const { privateKey } = await generateTunnelKeyPair();
  const sent: Frame[] = [];
  const socket = {
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(decodeFrame(frame));
    },
  };
  const connector = new Connector({
    relayUrl: new URL("ws://127.0.0.1:8080"),
    tunnelId: "authentication-test",
    privateKey,
    origin: new URL("http://127.0.0.1:3000"),
  }, { info() {}, warn() {}, error() {} });
  const internal = connector as unknown as {
    socket: typeof socket;
    onMessage(event: MessageEvent): Promise<void>;
  };
  internal.socket = socket;
  const challenge = encodeFrame(
    FrameType.challenge,
    "",
    encodeControl({ nonce: createNonce(), version: PROTOCOL_VERSION }),
  );
  const event = new MessageEvent("message", {
    data: challenge.buffer as ArrayBuffer,
  });

  await internal.onMessage(event);
  assertEquals(sent.map((frame) => frame.type), [FrameType.authenticate]);
  await assertRejects(() => internal.onMessage(event), /authentication response/);
});

Deno.test({
  name: "connector requires the negotiated WebSocket subprotocol",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const port = freePort();
    const serverAbort = new AbortController();
    const closed = Promise.withResolvers<number>();
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port,
      signal: serverAbort.signal,
      onListen() {},
    }, (request) => {
      const upgraded = Deno.upgradeWebSocket(request);
      upgraded.socket.onclose = (event) => closed.resolve(event.code);
      return upgraded.response;
    });
    const runAbort = new AbortController();
    const { privateKey } = await generateTunnelKeyPair();
    const connector = new Connector({
      relayUrl: new URL(`ws://127.0.0.1:${port}`),
      tunnelId: "subprotocol-test",
      privateKey,
      origin: new URL("http://127.0.0.1:3000"),
    }, {
      info() {},
      warn(event) {
        if (event === "connector_disconnected") runAbort.abort();
      },
      error() {},
    });

    try {
      await connector.run(runAbort.signal);
      assertEquals(await closed.promise, 4003);
    } finally {
      connector.stop();
      serverAbort.abort();
      await server.finished;
    }
  },
});

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

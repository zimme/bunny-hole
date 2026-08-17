import { calculateBackoffDelay, Connector } from "../apps/connector/connector.ts";
import { decodeFrame, Frame, FrameType, LIMITS } from "../packages/protocol/mod.ts";
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
    secret: "unused",
    origin: new URL("http://127.0.0.1:3000"),
  }, { info() {}, warn() {}, error() {} });
  const internal = connector as unknown as {
    socket: typeof socket;
    requests: Map<string, {
      id: string;
      abort: AbortController;
      started: boolean;
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
    started: true,
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
    secret: "unused",
    origin: new URL("http://127.0.0.1:3000"),
  }, { info() {}, warn() {}, error() {} });
  const request = {
    id: "abcdefghijklmnop",
    abort: new AbortController(),
    started: true,
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
    secret: "unused",
    origin: new URL("http://127.0.0.1:3000"),
  }, { info() {}, warn() {}, error() {} });
  type TestContext = {
    id: string;
    abort: AbortController;
    started: boolean;
    ended: boolean;
    responseDone: boolean;
    requestBytes: number;
    timeout: ReturnType<typeof setTimeout>;
  };
  const context: TestContext = {
    id: "abcdefghijklmnop",
    abort: new AbortController(),
    started: true,
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

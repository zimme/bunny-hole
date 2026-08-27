import {
  createCorrelationId,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  framePayloadChunks,
  FrameType,
  headerBlockBytes,
  LIMITS,
  pairsToHeaders,
  parseRequestStart,
  parseResponseStart,
  PROTOCOL_VERSION,
  ProtocolError,
  sendFrame,
  toWebSocketCloseCode,
  validateCorrelationId,
} from "../packages/protocol/mod.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "./assert.ts";

Deno.test("binary frame round trips without base64 body encoding", () => {
  const id = createCorrelationId();
  const payload = new Uint8Array([0, 255, 12, 0, 64]);
  const decoded = decodeFrame(encodeFrame(FrameType.requestBody, id, payload));
  assertEquals(decoded.type, FrameType.requestBody);
  assertEquals(decoded.id, id);
  assertEquals([...decoded.payload], [...payload]);
});

Deno.test("HTTP stream chunks are split into bounded binary frame payloads", () => {
  const input = Uint8Array.from(
    { length: LIMITS.maxFrameBytes * 2 + 17 },
    (_, index) => index % 251,
  );
  const chunks = [...framePayloadChunks(input)];
  assertEquals(chunks.map((chunk) => chunk.byteLength), [
    LIMITS.maxFrameBytes,
    LIMITS.maxFrameBytes,
    17,
  ]);
  assert(
    chunks.every((chunk, chunkIndex) =>
      chunk.every(
        (value, index) => value === input[chunkIndex * LIMITS.maxFrameBytes + index],
      )
    ),
  );
  assertEquals([...framePayloadChunks(new Uint8Array())], []);
  for (const chunk of chunks) {
    encodeFrame(FrameType.requestBody, createCorrelationId(), chunk);
  }
});

Deno.test("correlation identifiers are random, bounded, and validated", () => {
  const ids = new Set(Array.from({ length: 100 }, createCorrelationId));
  assertEquals(ids.size, 100);
  for (const id of ids) validateCorrelationId(id);
  assertThrows(() => validateCorrelationId("../bad"), /invalid correlation/);
  assertThrows(
    () => validateCorrelationId("a".repeat(LIMITS.maxCorrelationIdLength + 1)),
  );
});

Deno.test("decoder rejects truncated, unknown, oversized, and wrong-version frames", () => {
  assertThrows(() => decodeFrame(new Uint8Array([1, 2])), /truncated/);
  assertThrows(() => decodeFrame(new Uint8Array([1, 99, 0])), /unknown/);
  assertThrows(() => decodeFrame(new Uint8Array([2, 10, 0])), /version/);
  assertThrows(
    () =>
      encodeFrame(
        FrameType.requestBody,
        createCorrelationId(),
        new Uint8Array(LIMITS.maxFrameBytes + 1),
      ),
    /exceeds/,
  );
  assertThrows(() => encodeFrame(FrameType.requestStart, ""), /identifier/);
  assertThrows(
    () => encodeFrame(FrameType.ping, createCorrelationId()),
    /must not have an ID/,
  );
  assertThrows(
    () => encodeFrame(FrameType.cancel, createCorrelationId(), new Uint8Array([1])),
    /must not have a payload/,
  );
  assertThrows(() =>
    encodeFrame(
      FrameType.ping,
      "",
      new Uint8Array(LIMITS.maxControlBytes + 1),
    ), /control message exceeds/);
});

Deno.test("decoder reports malformed identifier UTF-8 as a protocol error", () => {
  const malformed = new Uint8Array(3 + 16);
  malformed.set([PROTOCOL_VERSION, FrameType.requestBody, 16]);
  malformed.fill(0xff, 3);
  let error: unknown;
  try {
    decodeFrame(malformed);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof ProtocolError);
  assertEquals(error.message, "invalid frame identifier");
});

Deno.test("control parser rejects malformed and unconstrained data", () => {
  assertThrows(() => decodeControl(new TextEncoder().encode("{")));
  assertThrows(() => encodeControl({ data: "x".repeat(LIMITS.maxControlBytes) }));
  const control = { version: 1, value: "ok" };
  assertEquals(decodeControl(encodeControl(control)), control);
});

Deno.test("control encoder reports unserializable values as protocol errors", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const value of [undefined, () => {}, 1n, cyclic]) {
    let error: unknown;
    try {
      encodeControl(value);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof ProtocolError);
    assertEquals(error.message, "invalid control message");
  }
});

Deno.test("request and response controls enforce syntax and orderable fields", () => {
  assertEquals(
    parseRequestStart({
      method: "POST",
      path: "/hello?x=1",
      headers: [{ name: "content-type", value: "text/plain" }],
    }).path,
    "/hello?x=1",
  );
  assertThrows(() => parseRequestStart({ method: "get", path: "/", headers: [] }));
  assertThrows(() =>
    parseRequestStart({ method: "GET", path: "//evil.example", headers: [] })
  );
  assertThrows(() =>
    parseRequestStart({ method: "GET", path: "/\\evil.example", headers: [] })
  );
  for (const method of ["CONNECT", "TRACE", "TRACK"]) {
    assertThrows(() => parseRequestStart({ method, path: "/", headers: [] }));
  }
  assertThrows(() =>
    parseRequestStart({
      method: "GET",
      path: "/",
      headers: [],
      remoteAddress: "x".repeat(129),
    })
  );
  assertEquals(parseResponseStart({ status: 201, headers: [] }).status, 201);
  assertThrows(() => parseResponseStart({ status: 101, headers: [] }));
  assertThrows(() => parseResponseStart({ status: 700, headers: [] }));
});

Deno.test("header pairs reject injection, excessive count, and bad names", () => {
  assertThrows(() => pairsToHeaders([{ name: "x-ok", value: "a\r\nx: b" }]));
  assertThrows(() => pairsToHeaders([{ name: "bad name", value: "x" }]));
  assertThrows(() =>
    pairsToHeaders(
      Array.from({ length: LIMITS.maxHeaders + 1 }, (_, index) => ({
        name: `x-${index}`,
        value: "x",
      })),
    )
  );
});

Deno.test("header block limits use UTF-8 bytes, not string length", () => {
  const asciiFit = "a".repeat(LIMITS.maxHeaderBytes - 5);
  const asciiPairs = [{ name: "x", value: asciiFit }];
  assertEquals(headerBlockBytes(asciiPairs), LIMITS.maxHeaderBytes);
  assertEquals(pairsToHeaders(asciiPairs).get("x"), asciiFit);

  const emoji = "😀";
  const emojiCount = Math.floor((LIMITS.maxHeaderBytes - 5) / 2);
  const oversized = [{ name: "x", value: emoji.repeat(emojiCount) }];
  assert(headerBlockBytes(oversized) > LIMITS.maxHeaderBytes);
  assert(oversized[0].value.length + 5 <= LIMITS.maxHeaderBytes);
  assertThrows(() => pairsToHeaders(oversized), /headers exceed limit/);
});

Deno.test("ProtocolError carries a safe WebSocket close code", () => {
  const error = new ProtocolError("bad", 1009);
  assert(error instanceof Error);
  assertEquals(error.closeCode, 1009);
  assertEquals(toWebSocketCloseCode(1000), 1000);
  assertEquals(toWebSocketCloseCode(1001), 4001);
  assertEquals(toWebSocketCloseCode(1008), 4008);
  assertEquals(toWebSocketCloseCode(1011), 4011);
  assertEquals(toWebSocketCloseCode(4101), 4101);
  assertEquals(toWebSocketCloseCode(99), 4002);
});

Deno.test("frame sending honors the buffered amount high-water mark", async () => {
  let bufferedAmount = LIMITS.maxBufferedAmount + 1;
  const sent: Uint8Array[] = [];
  const socket = {
    get bufferedAmount() {
      return bufferedAmount;
    },
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(frame);
    },
  } as unknown as WebSocket;
  const sending = sendFrame(socket, encodeFrame(FrameType.ping, ""));
  await Promise.resolve();
  assertEquals(sent.length, 0);
  bufferedAmount = 0;
  await sending;
  assertEquals(sent.length, 1);
});

Deno.test("frame sending bounds a permanently pressured connection", async () => {
  let sent = false;
  const socket = {
    bufferedAmount: LIMITS.maxBufferedAmount + 1,
    readyState: WebSocket.OPEN,
    send() {
      sent = true;
    },
  } as unknown as WebSocket;
  await assertRejects(
    () => sendFrame(socket, encodeFrame(FrameType.ping, ""), undefined, 10),
    /backpressure timeout/,
  );
  assertEquals(sent, false);
});

Deno.test("frame sending stops waiting when its request is cancelled", async () => {
  const socket = {
    bufferedAmount: LIMITS.maxBufferedAmount + 1,
    readyState: WebSocket.OPEN,
    send() {},
  } as unknown as WebSocket;
  const abort = new AbortController();
  const sending = sendFrame(
    socket,
    encodeFrame(FrameType.cancel, createCorrelationId()),
    abort.signal,
  );
  abort.abort(new Error("cancelled"));
  await assertRejects(() => sending, /cancelled/);
});

Deno.test("frame sending rejects an already cancelled request", async () => {
  const sent: Uint8Array[] = [];
  const socket = {
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send(frame: Uint8Array) {
      sent.push(frame);
    },
  } as unknown as WebSocket;
  const abort = new AbortController();
  abort.abort(new Error("cancelled before send"));
  await assertRejects(
    () => sendFrame(socket, encodeFrame(FrameType.ping, ""), abort.signal),
    /cancelled before send/,
  );
  assertEquals(sent.length, 0);
});

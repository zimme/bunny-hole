import {
  createCorrelationId,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  FrameType,
  LIMITS,
  pairsToHeaders,
  parseRequestStart,
  parseResponseStart,
  ProtocolError,
  validateCorrelationId,
} from "../packages/protocol/mod.ts";
import { assert, assertEquals, assertThrows } from "./assert.ts";

Deno.test("binary frame round trips without base64 body encoding", () => {
  const id = createCorrelationId();
  const payload = new Uint8Array([0, 255, 12, 0, 64]);
  const decoded = decodeFrame(encodeFrame(FrameType.requestBody, id, payload));
  assertEquals(decoded.type, FrameType.requestBody);
  assertEquals(decoded.id, id);
  assertEquals([...decoded.payload], [...payload]);
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
});

Deno.test("control parser rejects malformed and unconstrained data", () => {
  assertThrows(() => decodeControl(new TextEncoder().encode("{")));
  assertThrows(() => encodeControl({ data: "x".repeat(LIMITS.maxControlBytes) }));
  const control = { version: 1, value: "ok" };
  assertEquals(decodeControl(encodeControl(control)), control);
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
  assertEquals(parseResponseStart({ status: 201, headers: [] }).status, 201);
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

Deno.test("ProtocolError carries a safe WebSocket close code", () => {
  const error = new ProtocolError("bad", 1009);
  assert(error instanceof Error);
  assertEquals(error.closeCode, 1009);
});

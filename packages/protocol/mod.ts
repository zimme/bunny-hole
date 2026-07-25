export const PROTOCOL_VERSION = 1;
export const SUBPROTOCOL = "bunny-hole.v1";

export const LIMITS = Object.freeze({
  maxFrameBytes: 65_536,
  maxControlBytes: 16_384,
  maxBodyBytes: 10 * 1024 * 1024,
  maxHeaderBytes: 32_768,
  maxHeaders: 100,
  maxConcurrentRequests: 64,
  maxCorrelationIdLength: 43,
  requestTimeoutMs: 30_000,
  originTimeoutMs: 25_000,
  authenticationTimeoutMs: 5_000,
  heartbeatIntervalMs: 20_000,
  heartbeatTimeoutMs: 45_000,
  maxBufferedAmount: 1_048_576,
});

export const FrameType = Object.freeze({
  challenge: 1,
  authenticate: 2,
  authenticated: 3,
  requestStart: 10,
  requestBody: 11,
  requestEnd: 12,
  responseStart: 20,
  responseBody: 21,
  responseEnd: 22,
  cancel: 30,
  ping: 40,
  pong: 41,
  error: 255,
});

export type FrameTypeValue = typeof FrameType[keyof typeof FrameType];

const knownTypes = new Set<number>(Object.values(FrameType));
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const idPattern = /^[A-Za-z0-9_-]{16,43}$/;

export interface Frame {
  type: FrameTypeValue;
  id: string;
  payload: Uint8Array;
}

export interface HeaderPair {
  name: string;
  value: string;
}

export interface RequestStart {
  method: string;
  path: string;
  headers: HeaderPair[];
  remoteAddress?: string;
}

export interface ResponseStart {
  status: number;
  headers: HeaderPair[];
}

export class ProtocolError extends Error {
  constructor(message: string, readonly closeCode = 1002) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function toWebSocketCloseCode(code: number): number {
  if (code === 1000 || code >= 3000 && code <= 4999) return code;
  // WebSocket.close() only accepts 1000 or application codes 3000-4999.
  // Preserve the standard code's suffix in Bunny Hole's private 4000 range.
  if (code >= 1001 && code <= 1999) return 3000 + code;
  return 4002;
}

export function createCorrelationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return encodeBase64Url(bytes);
}

export function validateCorrelationId(id: string, allowEmpty = false): void {
  if (allowEmpty && id === "") return;
  if (!idPattern.test(id) || id.length > LIMITS.maxCorrelationIdLength) {
    throw new ProtocolError("invalid correlation identifier");
  }
}

export function encodeFrame(
  type: FrameTypeValue,
  id: string,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array {
  if (!knownTypes.has(type)) throw new ProtocolError("unknown frame type");
  validateCorrelationId(id, true);
  const idBytes = encoder.encode(id);
  if (payload.byteLength > LIMITS.maxFrameBytes) {
    throw new ProtocolError("frame payload exceeds limit", 1009);
  }
  const output = new Uint8Array(3 + idBytes.length + payload.length);
  output[0] = PROTOCOL_VERSION;
  output[1] = type;
  output[2] = idBytes.length;
  output.set(idBytes, 3);
  output.set(payload, 3 + idBytes.length);
  return output;
}

export function decodeFrame(input: ArrayBuffer | Uint8Array): Frame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 3) throw new ProtocolError("truncated frame");
  if (bytes[0] !== PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported protocol version", 1003);
  }
  const type = bytes[1] as FrameTypeValue;
  if (!knownTypes.has(type)) throw new ProtocolError("unknown frame type");
  const idLength = bytes[2];
  if (idLength > LIMITS.maxCorrelationIdLength || bytes.length < 3 + idLength) {
    throw new ProtocolError("invalid frame identifier");
  }
  const id = decoder.decode(bytes.subarray(3, 3 + idLength));
  validateCorrelationId(id, true);
  const payload = bytes.subarray(3 + idLength);
  if (payload.length > LIMITS.maxFrameBytes) {
    throw new ProtocolError("frame payload exceeds limit", 1009);
  }
  return { type, id, payload };
}

export function encodeControl(value: unknown): Uint8Array {
  const encoded = encoder.encode(JSON.stringify(value));
  if (encoded.length > LIMITS.maxControlBytes) {
    throw new ProtocolError("control message exceeds limit", 1009);
  }
  return encoded;
}

export function decodeControl(payload: Uint8Array): unknown {
  if (payload.length > LIMITS.maxControlBytes) {
    throw new ProtocolError("control message exceeds limit", 1009);
  }
  try {
    return JSON.parse(decoder.decode(payload));
  } catch {
    throw new ProtocolError("invalid control message");
  }
}

export function parseRequestStart(value: unknown): RequestStart {
  if (!isRecord(value)) throw new ProtocolError("invalid request start");
  const method = value.method;
  const path = value.path;
  if (
    typeof method !== "string" || !/^[A-Z]{1,16}$/.test(method) ||
    typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") ||
    path.length > 8_192 ||
    path.includes("\0") || path.includes("\r") || path.includes("\n")
  ) {
    throw new ProtocolError("invalid request target");
  }
  return {
    method,
    path,
    headers: parseHeaderPairs(value.headers),
    remoteAddress: typeof value.remoteAddress === "string"
      ? value.remoteAddress.slice(0, 128)
      : undefined,
  };
}

export function parseResponseStart(value: unknown): ResponseStart {
  if (!isRecord(value)) throw new ProtocolError("invalid response start");
  const status = value.status;
  if (
    typeof status !== "number" || !Number.isInteger(status) || status < 100 ||
    status > 599
  ) {
    throw new ProtocolError("invalid response status");
  }
  return { status, headers: parseHeaderPairs(value.headers) };
}

export function headersToPairs(headers: Headers): HeaderPair[] {
  const output: HeaderPair[] = [];
  headers.forEach((value, name) => output.push({ name, value }));
  validateHeaderPairs(output);
  return output;
}

export function pairsToHeaders(pairs: HeaderPair[]): Headers {
  validateHeaderPairs(pairs);
  const headers = new Headers();
  for (const { name, value } of pairs) headers.append(name, value);
  return headers;
}

export function validateHeaderPairs(pairs: HeaderPair[]): void {
  if (pairs.length > LIMITS.maxHeaders) {
    throw new ProtocolError("too many headers", 1009);
  }
  let bytes = 0;
  for (const pair of pairs) {
    if (
      !pair || typeof pair.name !== "string" ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(pair.name) ||
      typeof pair.value !== "string" ||
      /[\0\r\n]/.test(pair.value)
    ) throw new ProtocolError("invalid header");
    bytes += pair.name.length + pair.value.length + 4;
  }
  if (bytes > LIMITS.maxHeaderBytes) {
    throw new ProtocolError("headers exceed limit", 1009);
  }
}

function parseHeaderPairs(value: unknown): HeaderPair[] {
  if (!Array.isArray(value)) throw new ProtocolError("invalid headers");
  const pairs: HeaderPair[] = [];
  for (const item of value) {
    if (
      !isRecord(item) || typeof item.name !== "string" ||
      typeof item.value !== "string"
    ) throw new ProtocolError("invalid headers");
    pairs.push({ name: item.name, value: item.value });
  }
  validateHeaderPairs(pairs);
  return pairs;
}

export async function sendFrame(
  socket: WebSocket,
  frame: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  while (socket.bufferedAmount > LIMITS.maxBufferedAmount) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("send aborted", "AbortError");
    }
    if (socket.readyState !== WebSocket.OPEN) {
      throw new ProtocolError("connection closed", 1001);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (socket.readyState !== WebSocket.OPEN) {
    throw new ProtocolError("connection closed", 1001);
  }
  socket.send(frame);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ProtocolError("invalid encoding");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new ProtocolError("invalid encoding");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

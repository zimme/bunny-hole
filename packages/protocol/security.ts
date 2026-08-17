import { HeaderPair, LIMITS, ProtocolError } from "./mod.ts";

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const forwarding = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

export function filterPublicRequestHeaders(
  input: Headers,
  hostname: string,
  remoteAddress: string,
): HeaderPair[] {
  const connectionTokens = new Set(
    (input.get("connection") ?? "").split(",").map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  const output: HeaderPair[] = [];
  input.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (
      hopByHop.has(name) || isInternalHeader(name) || forwarding.has(name) ||
      connectionTokens.has(name)
    ) return;
    output.push({ name, value });
  });
  output.push({ name: "x-forwarded-host", value: hostname });
  output.push({ name: "x-forwarded-proto", value: "https" });
  if (remoteAddress) output.push({ name: "x-forwarded-for", value: remoteAddress });
  enforceHeaderLimit(output);
  return output;
}

export function filterOriginResponseHeaders(input: Headers): HeaderPair[] {
  const connectionTokens = new Set(
    (input.get("connection") ?? "").split(",").map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  const output: HeaderPair[] = [];
  input.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (
      hopByHop.has(name) || isInternalHeader(name) || connectionTokens.has(name) ||
      name === "server" || name === "content-length" || name === "set-cookie"
    ) return;
    output.push({ name, value });
  });
  for (const value of input.getSetCookie()) {
    output.push({ name: "set-cookie", value });
  }
  enforceHeaderLimit(output);
  return output;
}

export function normalizeHostname(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (/[\0-\x20\x7f]/.test(value)) throw new ProtocolError("invalid hostname");
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new ProtocolError("invalid hostname");
  }
  if (
    parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search ||
    parsed.hash
  ) throw new ProtocolError("invalid hostname");
  const hostname = parsed.hostname.replace(/\.$/, "");
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname;
  if (
    hostname.length < 1 || hostname.length > 253 ||
    !hostname.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))
  ) throw new ProtocolError("invalid hostname");
  return hostname;
}

export function validateOrigin(
  raw: string,
  allowPrivateNetwork: boolean,
): URL {
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new ProtocolError("invalid origin URL");
  }
  if (!["http:", "https:"].includes(origin.protocol)) {
    throw new ProtocolError("origin must use HTTP or HTTPS");
  }
  if (
    origin.username || origin.password || origin.search || origin.hash ||
    origin.pathname !== "/"
  ) throw new ProtocolError("origin must not contain credentials or a path");
  const host = origin.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "::1" || host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback && !allowPrivateNetwork) {
    throw new ProtocolError(
      "non-loopback origin requires explicit --allow-private-network opt-in",
    );
  }
  return origin;
}

function enforceHeaderLimit(pairs: HeaderPair[]): void {
  if (
    pairs.length > LIMITS.maxHeaders ||
    pairs.reduce((size, pair) => size + pair.name.length + pair.value.length + 4, 0) >
      LIMITS.maxHeaderBytes
  ) throw new ProtocolError("headers exceed limit", 1009);
}

function isInternalHeader(name: string): boolean {
  return name.startsWith("x-bunny-hole-");
}

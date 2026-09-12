import { LIMITS, normalizeHostname, ValidationError } from "./mod.ts";

const encoder = new TextEncoder();

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

export function secureRequestHeaders(
  input: Headers,
  hostname: string,
  remoteAddress: string,
): Headers {
  const connectionTokens = new Set(
    (input.get("connection") ?? "").split(",").map((value) =>
      value.trim().toLowerCase()
    )
      .filter(Boolean),
  );
  const output = new Headers();
  input.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (
      hopByHop.has(name) || name.startsWith("x-bunny-hole-") ||
      forwarding.has(name) || connectionTokens.has(name)
    ) return;
    output.append(name, value);
  });
  output.set("x-forwarded-host", normalizeHostname(hostname));
  output.set("x-forwarded-proto", "https");
  if (remoteAddress) output.set("x-forwarded-for", safeRemoteAddress(remoteAddress));
  enforceHeaders(output);
  return output;
}

export function assertHeaderLimits(headers: Headers): void {
  enforceHeaders(headers);
}

export function secureResponseHeaders(input: Headers): Headers {
  const connectionTokens = new Set(
    (input.get("connection") ?? "").split(",").map((value) =>
      value.trim().toLowerCase()
    )
      .filter(Boolean),
  );
  const output = new Headers();
  input.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (
      hopByHop.has(name) || name.startsWith("x-bunny-hole-") ||
      connectionTokens.has(name) || name === "server" || name === "content-length" ||
      name === "set-cookie"
    ) return;
    output.append(name, value);
  });
  for (const cookie of input.getSetCookie()) output.append("set-cookie", cookie);
  output.set("cache-control", "no-store");
  enforceHeaders(output);
  return output;
}

export function validateOrigin(raw: string, allowPrivateNetwork: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("invalid origin URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ValidationError("origin must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.hash || url.search || url.pathname !== "/") {
    throw new ValidationError("origin must contain only an origin");
  }
  const host = url.hostname.toLowerCase();
  const octets = host.split(".");
  const loopbackV4 = octets.length === 4 && octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
  const loopback = host === "localhost" || host === "::1" || loopbackV4;
  if (!loopback && !allowPrivateNetwork) {
    throw new ValidationError(
      "non-loopback origin requires explicit private-network opt-in",
    );
  }
  return url;
}

function safeRemoteAddress(value: string): string {
  if (value.length > 128 || /[\0\r\n]/.test(value)) {
    throw new ValidationError("invalid remote address");
  }
  return value;
}

function enforceHeaders(headers: Headers): void {
  let count = 0;
  let bytes = 0;
  headers.forEach((value, name) => {
    count++;
    bytes += encoder.encode(name).length + encoder.encode(value).length + 4;
  });
  if (count > LIMITS.maxHeaders || bytes > LIMITS.maxHeaderBytes) {
    throw new ValidationError("headers exceed limit");
  }
}

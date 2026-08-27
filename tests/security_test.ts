import {
  filterOriginResponseHeaders,
  filterPublicRequestHeaders,
  normalizeHostname,
  validateOrigin,
} from "../packages/protocol/security.ts";
import { pairsToHeaders } from "../packages/protocol/mod.ts";
import { assert, assertEquals, assertThrows } from "./assert.ts";

Deno.test("public header filter strips control, hop-by-hop, and spoofed forwarding data", () => {
  const headers = new Headers({
    authorization: "Bearer viewer-value",
    connection: "x-remove",
    cookie: "viewer=allowed",
    forwarded: "for=attacker",
    "proxy-connection": "keep-alive",
    "x-bunny-hole-future-control": "never",
    "x-bunny-hole-secret": "never",
    "x-forwarded-for": "attacker",
    "x-remove": "bad",
    "x-safe": "yes",
  });
  const pairs = filterPublicRequestHeaders(headers, "app.example.com", "192.0.2.1");
  const output = new Headers(pairs.map(({ name, value }) => [name, value]));
  assertEquals(output.get("x-safe"), "yes");
  assertEquals(output.get("authorization"), "Bearer viewer-value");
  assertEquals(output.get("cookie"), "viewer=allowed");
  assertEquals(output.get("proxy-connection"), null);
  assertEquals(output.get("x-bunny-hole-secret"), null);
  assertEquals(output.get("x-bunny-hole-future-control"), null);
  assertEquals(output.get("x-remove"), null);
  assertEquals(output.get("x-forwarded-for"), "192.0.2.1");
  assertEquals(output.get("x-forwarded-proto"), "https");
});

Deno.test("origin response filter strips internal and hop-by-hop headers", () => {
  const pairs = filterOriginResponseHeaders(
    new Headers({
      connection: "x-private",
      "content-length": "2",
      "proxy-connection": "close",
      server: "fixture",
      "x-bunny-hole-id": "secret-control",
      "x-bunny-hole-unknown": "secret-control",
      "x-private": "bad",
      "x-safe": "ok",
    }),
  );
  const output = new Headers(pairs.map(({ name, value }) => [name, value]));
  assertEquals(output.get("x-safe"), "ok");
  assertEquals(output.get("server"), null);
  assertEquals(output.get("content-length"), null);
  assertEquals(output.get("proxy-connection"), null);
  assertEquals(output.get("x-private"), null);
  assertEquals(output.get("x-bunny-hole-id"), null);
  assertEquals(output.get("x-bunny-hole-unknown"), null);
});

Deno.test("header filters enforce UTF-8 byte limits", () => {
  // Fetch Headers are Latin-1 ByteStrings. A 0xFF unit is one code unit but two
  // UTF-8 bytes, so a JS-length check would accept a block over 32 KiB.
  const value = "\u00FF".repeat(20_000);
  assertThrows(
    () =>
      filterPublicRequestHeaders(
        new Headers({ "x-data": value }),
        "app.example.com",
        "192.0.2.1",
      ),
    /headers exceed limit/,
  );
  assertThrows(
    () => filterOriginResponseHeaders(new Headers({ "x-data": value })),
    /headers exceed limit/,
  );
});

Deno.test("origin response filter preserves separate Set-Cookie fields", () => {
  const headers = new Headers();
  headers.append("set-cookie", "first=one; Path=/; HttpOnly");
  headers.append("set-cookie", "second=two; Path=/; Secure");
  const pairs = filterOriginResponseHeaders(headers);

  assertEquals(
    pairs.filter(({ name }) => name === "set-cookie").map(({ value }) => value),
    ["first=one; Path=/; HttpOnly", "second=two; Path=/; Secure"],
  );
  assertEquals(pairsToHeaders(pairs).getSetCookie(), [
    "first=one; Path=/; HttpOnly",
    "second=two; Path=/; Secure",
  ]);
});

Deno.test("hostname normalization prevents confusion", () => {
  assertEquals(normalizeHostname("App.Example.COM:443"), "app.example.com");
  assertEquals(normalizeHostname("app.example.com."), "app.example.com");
  assertEquals(normalizeHostname("[::1]:8080"), "[::1]");
  assertEquals(normalizeHostname("[2001:db8::1]"), "[2001:db8::1]");
  assertEquals(normalizeHostname("127.0.0.1:8080"), "127.0.0.1");
  for (
    const bad of [
      "",
      "evil..example",
      "-bad.example",
      "good.example\r\nx",
      "good.example:99999",
      "user@good.example",
      "good.example/path",
    ]
  ) {
    assertThrows(() => normalizeHostname(bad));
  }
});

Deno.test("connector origin defaults to loopback-only policy", () => {
  assertEquals(validateOrigin("http://127.0.0.1:3000", false).port, "3000");
  assertEquals(validateOrigin("http://127.1:3000", false).hostname, "127.0.0.1");
  assertEquals(validateOrigin("http://127.0.1:3000", false).hostname, "127.0.0.1");
  assertEquals(validateOrigin("http://[::1]:3000", false).port, "3000");
  assertThrows(() => validateOrigin("http://127.attacker.example", false), /opt-in/);
  assertThrows(() => validateOrigin("http://192.168.1.3", false), /opt-in/);
  assert(validateOrigin("http://192.168.1.3", true) instanceof URL);
  assertThrows(() => validateOrigin("file:///etc/passwd", true));
  assertThrows(() => validateOrigin("http://user:pass@localhost", true));
  assertThrows(() => validateOrigin("http://localhost/base", true));
});

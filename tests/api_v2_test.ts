import { assertEquals, assertThrows } from "./assert.ts";
import { generateKeyPair, sign, verify } from "../packages/api/auth.ts";
import {
  grantAllowsRoute,
  normalizeHostname,
  parseId,
  validateGrant,
} from "../packages/api/mod.ts";
import { secureRequestHeaders, validateOrigin } from "../packages/api/security.ts";

Deno.test("Ed25519 signatures are context separated", async () => {
  const keys = await generateKeyPair();
  const signature = await sign(keys.privateKey, "session", ["a", "b"]);
  assertEquals(await verify(keys.publicKey, "session", ["a", "b"], signature), true);
  assertEquals(
    await verify(keys.publicKey, "approve-enrollment", ["a", "b"], signature),
    false,
  );
  assertEquals(await verify(keys.publicKey, "session", ["a", "c"], signature), false);
});

Deno.test("identifier prefixes cannot alter validation syntax", () => {
  assertThrows(
    () => parseId("enr_AAAAAAAAAAAAAAAAAAAAAAAA", "enr|.*"),
    /invalid identifier/,
  );
});

Deno.test("grants match only explicit hostnames, suffixes, and protocols", () => {
  const grant = validateGrant({
    exactHostnames: ["home.example.com"],
    hostnameSuffixes: ["dev.example.com"],
    protocols: ["http"],
    maxRoutes: 4,
  });
  const base = {
    id: "rte_AAAAAAAAAAAAAAAAAAAAAAAA",
    enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
    name: "test",
    targetHost: "127.0.0.1",
    targetPort: 3000,
    allowPrivateNetwork: false,
    active: true,
  } as const;
  assertEquals(
    grantAllowsRoute(grant, {
      ...base,
      protocol: "http",
      hostname: "home.example.com",
    }),
    true,
  );
  assertEquals(
    grantAllowsRoute(grant, {
      ...base,
      protocol: "http",
      hostname: "x.dev.example.com",
    }),
    true,
  );
  assertEquals(
    grantAllowsRoute(grant, {
      ...base,
      protocol: "http",
      hostname: "dev.example.com.attacker.test",
    }),
    false,
  );
});

Deno.test("headers and origin policy fail closed", () => {
  const headers = secureRequestHeaders(
    new Headers({
      authorization: "viewer-value",
      connection: "x-smuggle",
      "x-smuggle": "bad",
      "x-forwarded-for": "spoofed",
      "x-bunny-hole-token": "secret",
    }),
    "home.example.com",
    "192.0.2.4",
  );
  assertEquals(headers.get("authorization"), "viewer-value");
  assertEquals(headers.get("x-smuggle"), null);
  assertEquals(headers.get("x-bunny-hole-token"), null);
  assertEquals(headers.get("x-forwarded-for"), "192.0.2.4");
  assertThrows(
    () => validateOrigin("http://home.internal:8123", false),
    /explicit private-network opt-in/,
  );
  assertThrows(() => validateOrigin("http://127.999.999.999:8123", false));
  assertEquals(validateOrigin("http://127.1:8123", false).hostname, "127.0.0.1");
  assertEquals(normalizeHostname("HOME.Example.com."), "home.example.com");
});

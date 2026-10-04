import { routesFromCompose } from "../apps/compose/model.ts";
import { loadHostConfig, redactedHostConfig } from "../apps/host/config.ts";
import { loadOrCreateIdentity } from "../apps/host/identity.ts";
import {
  defaultStatePath,
  loadState,
  loadStateOrEmpty,
  saveState,
  selectHost,
} from "../apps/connector/state.ts";
import { createLogger } from "../packages/api/logger.ts";
import {
  generateKeyPair,
  sign,
  validatePublicKey,
  verify,
} from "../packages/api/auth.ts";
import {
  createId,
  decodeBase64Url,
  normalizeHostname,
  parseId,
  parseName,
  parsePort,
  parseProtocol,
  validateGrant,
} from "../packages/api/mod.ts";
import {
  assertHeaderLimits,
  isDevelopmentHostname,
  secureRequestHeaders,
  secureResponseHeaders,
  validateOrigin,
} from "../packages/api/security.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "./assert.ts";

Deno.test("API parsers reject malformed, oversized and wrong-type boundary inputs", () => {
  for (const value of [null, 1, "", " ", "a\0b", "a\rb", "a\nb", "é".repeat(65)]) {
    assertThrows(() => parseName(value));
  }
  assertEquals(parseName(" é "), "é");
  assertEquals(parseName("a".repeat(128)).length, 128);
  for (const value of [0, 65536, 1.5, NaN, Infinity, "80", null]) {
    assertThrows(() => parsePort(value));
  }
  assertEquals(parsePort(1), 1);
  assertEquals(parsePort(65535), 65535);
  for (const value of [null, "", "HTTP", "tcp"]) {
    assertThrows(() => parseProtocol(value));
  }
  for (const prefix of ["", "A", "x", "ab.*", "a".repeat(17)]) {
    assertThrows(() => createId(prefix));
    assertThrows(() => parseId("enr_AAAAAAAAAAAAAAAAAAAAAAAA", prefix));
  }
  for (
    const value of [
      null,
      5,
      "a b",
      "a\u007fb",
      "-x.test",
      "x-.test",
      "a..test",
      "a".repeat(64),
      "a.".repeat(128),
    ]
  ) assertThrows(() => normalizeHostname(value));
  for (const value of ["", "!", "A", "===="]) {
    assertThrows(() => decodeBase64Url(value));
  }
  const grant = {
    exactHostnames: [],
    hostnameSuffixes: [],
    protocols: ["http"],
    maxRoutes: 1,
  };
  for (
    const value of [
      null,
      { ...grant, extra: 1 },
      { ...grant, protocols: [1] },
      { ...grant, exactHostnames: Array(257).fill("a.test") },
      { ...grant, maxRoutes: 0 },
      { ...grant, maxRoutes: 257 },
      { ...grant, maxRoutes: 1.5 },
    ]
  ) assertThrows(() => validateGrant(value));
});

Deno.test("origin and header policy rejects unsafe framing and preserves application cookies", () => {
  for (
    const origin of [
      "bad url",
      "ftp://localhost",
      "http://user:pass@localhost",
      "http://localhost/path",
      "http://localhost/?x=1",
      "http://localhost/#x",
    ]
  ) assertThrows(() => validateOrigin(origin, true));
  assertEquals(validateOrigin("https://[::1]:443", false).hostname, "[::1]");
  for (
    const [host, permitted] of [
      ["::1", true],
      ["[::1]", true],
      ["app.localhost", true],
      ["127.0.0.255", true],
      ["127.0.0.256", false],
      ["localhost.attacker.com", false],
      ["bad host", false],
    ] as const
  ) assertEquals(isDevelopmentHostname(host), permitted);
  assertThrows(
    () => secureRequestHeaders(new Headers(), "app.test", "x".repeat(129)),
    /remote address/,
  );
  assertThrows(
    () => secureRequestHeaders(new Headers(), "app.test", "x\ny"),
    /remote address/,
  );
  const excessive = new Headers();
  for (let i = 0; i < 101; i++) excessive.set(`x-${i}`, "v");
  assertThrows(() => assertHeaderLimits(excessive), /limit/);
  assertThrows(
    () => assertHeaderLimits(new Headers({ a: "x".repeat(32768) })),
    /limit/,
  );
  const cookies = new Headers({
    connection: "Set-Cookie, X-Dynamic",
    "x-dynamic": "secret",
    "set-cookie": "session=secret",
    server: "private",
  });
  const filtered = secureResponseHeaders(cookies);
  assertEquals(filtered.getSetCookie(), []);
  assertEquals(filtered.get("x-dynamic"), null);
  assertEquals(filtered.get("server"), null);
  assertEquals(
    secureRequestHeaders(new Headers(), "APP.TEST", "").get("x-forwarded-for"),
    null,
  );
});

Deno.test("signature contexts and malformed key material fail closed", async () => {
  const pair = await generateKeyPair();
  for (const purpose of ["", "UPPER", "a".repeat(65), "a\0b"]) {
    await assertRejects(() => sign(pair.privateKey, purpose, ["a"]), /context/);
    assertEquals(await verify(pair.publicKey, purpose, ["a"], "A".repeat(86)), false);
  }
  await assertRejects(() => sign(pair.privateKey, "test", ["a\0b"]), /context/);
  await assertRejects(() => sign("AA", "test", []), /private key/);
  for (const key of [null, "!", "AA"]) {
    assertThrows(() => validatePublicKey(key), /public key/);
  }
  assertEquals(await verify("!", "test", [], "!"), false);
  assertEquals(await verify("AA", "test", [], "AA"), false);
});

Deno.test("logger redacts nested secrets in JSON and pretty output at every level", () => {
  const original = console.log;
  const output: string[] = [];
  console.log = (value: unknown) => output.push(String(value));
  try {
    for (const format of ["json", "pretty"] as const) {
      const logger = createLogger(format);
      logger.info("ready");
      logger.warn("policy", {
        nested: [{
          public: "visible",
          accessToken: "hidden",
          details: { privateKey: "hidden", cookie: "hidden", proof: "hidden" },
        }],
        nullValue: null,
        count: 2,
      });
      logger.error("failed", { authorization: "hidden", secret: "hidden" });
    }
    assertEquals(output.length, 6);
    assert(output.every((value) => !value.includes("hidden")));
    const json = JSON.parse(output[1]);
    assertEquals(json.level, "warn");
    assertEquals(json.nested[0].public, "visible");
    assertEquals(json.nested[0].details.privateKey, "[REDACTED]");
    assertEquals(json.nullValue, null);
    assertEquals(json.count, 2);
    assert(Number.isFinite(Date.parse(json.time)));
    assert(output[4].startsWith("WARN policy "));
  } finally {
    console.log = original;
  }
});

Deno.test("host configuration checks timeout, paths, logging and duplicate transports", async () => {
  const owner = await generateKeyPair();
  const base = {
    BUNNY_HOLE_PUBLIC_URL: "https://hole.example.com",
    BUNNY_HOLE_OWNER_PUBLIC_KEY: owner.publicKey,
  };
  for (const timeout of ["999", "120001", "1000.5", "bad"]) {
    assertThrows(
      () => loadHostConfig({ ...base, BUNNY_HOLE_REQUEST_TIMEOUT_MS: timeout }),
      /timeout/,
    );
  }
  for (
    const field of [
      "BUNNY_HOLE_STATE_PATH",
      "BUNNY_HOLE_IDENTITY_PATH",
      "BUNNY_HOLE_FRPS_PATH",
    ]
  ) assertThrows(() => loadHostConfig({ ...base, [field]: "" }), /paths/);
  for (const transports of ["", "wss,wss", "websocket"]) {
    assertThrows(
      () => loadHostConfig({ ...base, BUNNY_HOLE_CONNECTOR_TRANSPORTS: transports }),
      /transports/,
    );
  }
  assertThrows(
    () => loadHostConfig({ ...base, BUNNY_HOLE_LOG_FORMAT: "xml" }),
    /log format/,
  );
  const config = loadHostConfig({
    ...base,
    BUNNY_HOLE_LOG_FORMAT: "pretty",
    BUNNY_HOLE_REQUEST_TIMEOUT_MS: "120000",
  });
  const redacted = redactedHostConfig(config);
  assertEquals(redacted.requestTimeoutMs, 120000);
  assertEquals(redacted.logFormat, "pretty");
  assertEquals(redacted.ownerKeyConfigured, true);
  assertEquals(JSON.stringify(redacted).includes(owner.publicKey), false);
});

Deno.test("Compose rejects invalid declarations and produces deterministic explicit private routes", () => {
  for (const value of [null, {}, { services: [] }]) {
    assertThrows(() => routesFromCompose(value), /model/);
  }
  const labels = {
    "dev.bunny-hole.host": "home",
    "dev.bunny-hole.hostname": "APP.TEST.",
    "dev.bunny-hole.target-port": "443",
  };
  for (
    const changes of [
      { "dev.bunny-hole.host": "Bad" },
      { "dev.bunny-hole.protocol": "tcp" },
      { "dev.bunny-hole.hostname": "" },
      { "dev.bunny-hole.target-port": "0" },
      { "dev.bunny-hole.target-host": "service" },
    ]
  ) {
    assertThrows(() =>
      routesFromCompose({ services: { app: { labels: { ...labels, ...changes } } } })
    );
  }
  assertEquals(
    routesFromCompose({
      services: {
        invalid: null,
        unlabeled: { labels: {} },
        wrong: { labels: { "dev.bunny-hole.host": 1 } },
      },
    }),
    [],
  );
  const routes = routesFromCompose({
    name: "preview",
    services: {
      z: { labels },
      a: {
        labels: {
          ...labels,
          "dev.bunny-hole.name": "compose-existing",
          "dev.bunny-hole.protocol": "https",
          "dev.bunny-hole.target-host": "::1",
        },
      },
      private: {
        labels: {
          ...labels,
          "dev.bunny-hole.target-host": "service",
          "dev.bunny-hole.allow-private-network": "true",
        },
      },
    },
  });
  assertEquals(routes.map((route) => route.name), [
    "compose-existing",
    "compose-preview-private",
    "compose-preview-z",
  ]);
  assertEquals(routes[0].targetHost, "::1");
  assertEquals(routes[0].protocol, "https");
  assertEquals(routes[1].allowPrivateNetwork, true);
  assert(routes.every((route) => route.hostname === "app.test"));
});

Deno.test("connector state rejects invalid defaults, names, versions and excess hosts without overwriting files", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/config.json`;
  try {
    assertEquals(
      defaultStatePath({ XDG_CONFIG_HOME: "/cfg" }),
      "/cfg/bunny-hole/config.json",
    );
    assertEquals(
      defaultStatePath({ HOME: "/home/test" }),
      "/home/test/.config/bunny-hole/config.json",
    );
    assertThrows(() => defaultStatePath({}), /directory/);
    assertEquals(await loadStateOrEmpty(path), { version: 1, hosts: {} });
    assertThrows(() => selectHost({ version: 1, hosts: {} }), /not configured/);
    const pair = await generateKeyPair();
    const credentials = {
      ...pair,
      identityPublicKey: pair.publicKey,
      enrollmentId: "enr_AAAAAAAAAAAAAAAAAAAAAAAA",
      url: "https://hole.example.com/",
    };
    for (
      const value of [
        null,
        { version: 2, hosts: {} },
        { version: 1, hosts: [] },
        { version: 1, hosts: { "Bad name": credentials } },
        { version: 1, hosts: { home: null } },
        { version: 1, hosts: {}, defaultHost: "absent" },
        { version: 1, hosts: {}, defaultHost: 1 },
        {
          version: 1,
          hosts: Object.fromEntries(
            Array.from({ length: 65 }, (_, i) => [`host-${i}`, credentials]),
          ),
        },
      ]
    ) {
      await Deno.writeTextFile(path, JSON.stringify(value), { mode: 0o600 });
      await assertRejects(() => loadStateOrEmpty(path), /config|default host/);
      assertEquals(await Deno.readTextFile(path), JSON.stringify(value));
    }
    await saveState({ version: 1, hosts: { home: credentials } }, path);
    const [name, selected] = selectHost(await loadState(path), "home");
    assertEquals(name, "home");
    for (const key of Object.keys(credentials) as (keyof typeof credentials)[]) {
      assertEquals(selected[key], credentials[key]);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("host identity rejects malformed and mismatched key files", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/identity.json`;
  try {
    const first = await loadOrCreateIdentity(path);
    assertEquals(await loadOrCreateIdentity(path), first);
    for (
      const value of [null, {}, { ...first, publicKey: "AA" }, {
        ...first,
        privateKey: "AA",
      }]
    ) {
      await Deno.writeTextFile(path, JSON.stringify(value), { mode: 0o600 });
      await assertRejects(() => loadOrCreateIdentity(path), /identity file/);
      assertEquals(await Deno.readTextFile(path), JSON.stringify(value));
    }
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...first,
        ...(await generateKeyPair()),
        publicKey: first.publicKey,
      }),
    );
    await assertRejects(() => loadOrCreateIdentity(path), /does not match/);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("fingerprints use the first eight SHA-256 bytes in a stable display format", async () => {
  const { fingerprint } = await import("../packages/api/auth.ts");
  assertEquals(await fingerprint("YWJj"), "ba:78:16:bf:8f:01:cf:ea");
});

import { loadHostConfig } from "../apps/host/config.ts";
import { frpsConfig } from "../apps/host/frp.ts";
import { generateKeyPair } from "../packages/api/auth.ts";
import { assertEquals, assertThrows } from "./assert.ts";

const owner = await generateKeyPair();
const base = {
  BUNNY_HOLE_OWNER_PUBLIC_KEY: owner.publicKey,
  BUNNY_HOLE_PUBLIC_URL: "https://hole.example.com",
};

Deno.test("host configuration permits only secure production transports", () => {
  assertEquals(loadHostConfig(base).connectorTransports, ["wss"]);
  assertEquals(
    loadHostConfig({
      ...base,
      CI: "true",
      BUNNY_HOLE_ENVIRONMENT_NAME: "development",
    }).development,
    false,
  );
  const productionFrps = frpsConfig(loadHostConfig(base));
  assertEquals(productionFrps.includes("transport.tls.force = false"), true);
  assertEquals(productionFrps.includes("transport.tls.force = true"), false);
  assertEquals(
    loadHostConfig({ ...base, BUNNY_HOLE_PUBLIC_URL: "https://hole.example.com." })
      .publicUrl.hostname,
    "hole.example.com",
  );
  assertEquals(
    loadHostConfig({ ...base, BUNNY_HOLE_PUBLIC_URL: "https://hole.example.com." })
      .publicUrl.href,
    "https://hole.example.com/",
  );
  assertThrows(
    () => loadHostConfig({ ...base, BUNNY_HOLE_PUBLIC_URL: "http://hole.example.com" }),
    /HTTPS/,
  );
  assertThrows(
    () => loadHostConfig({ ...base, BUNNY_HOLE_CONNECTOR_TRANSPORTS: "tcp" }),
    /connector transports/,
  );
  assertThrows(
    () =>
      loadHostConfig({ ...base, BUNNY_HOLE_PUBLIC_URL: "https://hole.example.com/x" }),
    /only an origin/,
  );
});

Deno.test("host configuration fails closed on secrets and port collisions", () => {
  assertThrows(() => loadHostConfig({}), /PUBLIC_URL/);
  assertThrows(
    () => loadHostConfig({ BUNNY_HOLE_PUBLIC_URL: "https://hole.example.com" }),
    /OWNER_PUBLIC_KEY/,
  );
  assertThrows(
    () => loadHostConfig({ ...base, BUNNY_HOLE_PUBLIC_URL: "not a URL" }),
    /public URL/,
  );
  assertThrows(
    () => loadHostConfig({ ...base, BUNNY_HOLE_OWNER_PUBLIC_KEY: "not-a-key" }),
    /public key/,
  );
  assertThrows(
    () => loadHostConfig({ ...base, BUNNY_HOLE_FRP_BIND_PORT: "8080" }),
    /ports must be distinct/,
  );
});

Deno.test("development explicitly permits direct transports", () => {
  const secureDefaults = loadHostConfig({
    ...base,
    BUNNY_HOLE_DEVELOPMENT: "true",
    BUNNY_HOLE_PUBLIC_URL: "https://host.test",
  });
  assertEquals(secureDefaults.connectorTransports, ["wss"]);
  assertEquals(secureDefaults.connectorPort, 443);
  const config = loadHostConfig({
    ...base,
    BUNNY_HOLE_DEVELOPMENT: "true",
    BUNNY_HOLE_PUBLIC_URL: "http://127.0.0.1:8080",
    BUNNY_HOLE_CONNECTOR_HOST: "host.test",
    BUNNY_HOLE_CONNECTOR_TRANSPORTS: "tcp,quic",
  });
  assertEquals(config.development, true);
  assertEquals(config.connectorTransports, ["tcp", "quic"]);
  assertEquals(frpsConfig(config).includes("quicBindPort = 7000"), true);
  assertEquals(frpsConfig(config).includes('proxyBindAddr = "127.0.0.1"'), true);
  assertEquals(
    frpsConfig(loadHostConfig(base)).includes("quicBindPort"),
    false,
  );
  assertThrows(
    () => loadHostConfig({ ...base, BUNNY_HOLE_DEVELOPMENT: "true" }),
    /local management hostname/,
  );
  assertThrows(
    () =>
      loadHostConfig({
        ...base,
        BUNNY_HOLE_DEVELOPMENT: "true",
        BUNNY_HOLE_PUBLIC_URL: "ftp://host.test",
      }),
    /HTTPS outside development/,
  );
  assertThrows(
    () =>
      loadHostConfig({
        ...base,
        BUNNY_HOLE_DEVELOPMENT: "true",
        BUNNY_HOLE_PUBLIC_URL: "http://host.test",
        BUNNY_HOLE_CONNECTOR_HOST: "connect.example.com",
      }),
    /local connector hostname/,
  );
  assertThrows(
    () =>
      loadHostConfig({
        BUNNY_HOLE_OWNER_PUBLIC_KEY: owner.publicKey,
        BUNNY_HOLE_DEVELOPMENT: "true",
      }),
    /PUBLIC_URL/,
  );
});

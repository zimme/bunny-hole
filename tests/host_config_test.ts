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
    loadHostConfig({ ...base, BUNNY_HOLE_PUBLIC_URL: "https://hole.example.com." })
      .publicUrl.hostname,
    "hole.example.com",
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

Deno.test("local development explicitly permits direct transports", () => {
  const config = loadHostConfig({
    ...base,
    BUNNY_HOLE_LOCAL_DEVELOPMENT: "true",
    BUNNY_HOLE_PUBLIC_URL: "http://127.0.0.1:8080",
    BUNNY_HOLE_CONNECTOR_HOST: "host.test",
    BUNNY_HOLE_CONNECTOR_TRANSPORTS: "tcp,quic",
  });
  assertEquals(config.localDevelopment, true);
  assertEquals(config.connectorTransports, ["tcp", "quic"]);
  assertEquals(frpsConfig(config).includes("quicBindPort = 7000"), true);
  assertEquals(frpsConfig(config).includes('proxyBindAddr = "127.0.0.1"'), true);
  assertEquals(
    frpsConfig(loadHostConfig(base)).includes("quicBindPort"),
    false,
  );
});

import { generateTunnelKeyPair } from "../packages/protocol/auth.ts";
import { loadConnectorConfig } from "../apps/connector/config.ts";
import { parseFlags } from "../apps/connector/main.ts";
import { loadRelayConfig, redactedConfig } from "../apps/relay/config.ts";
import { assertEquals, assertRejects, assertThrows } from "./assert.ts";

Deno.test("connector CLI flags reject ambiguity and secret arguments", () => {
  assertEquals(parseFlags(["--relay", "wss://relay.example"], ["relay"]), {
    relay: "wss://relay.example",
  });
  assertThrows(() => parseFlags(["--unknown", "value"], ["relay"]), /unknown/);
  assertThrows(
    () => parseFlags(["--relay", "one", "--relay", "two"], ["relay"]),
    /duplicate/,
  );
  assertThrows(() => parseFlags(["--secret", "value"], ["secret"]), /forbidden/);
  assertThrows(
    () => parseFlags(["--private-key", "value"], ["private-key"]),
    /forbidden/,
  );
});

Deno.test("relay config is fail-closed and maps only explicit hostnames", async () => {
  const { publicKey } = await generateTunnelKeyPair();
  const config = loadRelayConfig({
    BUNNY_HOLE_TUNNELS: JSON.stringify([
      { id: "alpha", publicKey, hostnames: ["A.Example.com"] },
    ]),
  });
  assertEquals(config.hostnameToTunnel.get("a.example.com"), "alpha");
  assertEquals(config.hostnameToTunnel.get("b.example.com"), undefined);
  assertEquals(
    (redactedConfig(config).tunnels as Record<string, unknown>[])[0].publicKey,
    "[CONFIGURED]",
  );
  assertThrows(() => loadRelayConfig({}), /required/);
  assertThrows(() =>
    loadRelayConfig({
      BUNNY_HOLE_LOCAL_DEVELOPMENT: "yes",
      BUNNY_HOLE_TUNNELS: "[]",
    }), /true or false/);
  assertThrows(() =>
    loadRelayConfig({
      BUNNY_HOLE_LOG_FORMAT: "verbose",
      BUNNY_HOLE_TUNNELS: JSON.stringify([
        { id: "alpha", publicKey, hostnames: ["alpha.example"] },
      ]),
    }), /json or pretty/);
  assertThrows(() =>
    loadRelayConfig({
      BUNNY_HOLE_TUNNELS: JSON.stringify([
        { id: "alpha", publicKey, hostnames: ["alpha.example"], typo: true },
      ]),
    }), /unknown fields/);
  assertThrows(() =>
    loadRelayConfig({
      BUNNY_HOLE_TUNNELS: JSON.stringify([
        { id: "alpha", publicKey: "not-a-key", hostnames: ["alpha.example"] },
      ]),
    }), /public key/);
  assertThrows(() =>
    loadRelayConfig({
      BUNNY_HOLE_TUNNELS: JSON.stringify([
        { id: "alpha", secret: "obsolete", hostnames: ["alpha.example"] },
      ]),
    }), /unknown fields/);
  assertThrows(() =>
    loadRelayConfig({
      BUNNY_HOLE_TUNNELS: JSON.stringify([
        { id: "one", publicKey, hostnames: ["same.example"] },
        { id: "two", publicKey, hostnames: ["same.example"] },
      ]),
    })
  );
});

Deno.test("connector config requires WSS and explicit private-network opt-in", async () => {
  const { privateKey } = await generateTunnelKeyPair();
  const base = {
    BUNNY_HOLE_RELAY_URL: "wss://relay.example",
    BUNNY_HOLE_TUNNEL_ID: "alpha",
    BUNNY_HOLE_TUNNEL_PRIVATE_KEY: privateKey,
  };
  const config = await loadConnectorConfig({}, base);
  assertEquals(config.origin.href, "http://127.0.0.1:3000/");
  await assertRejects(() =>
    loadConnectorConfig({}, {
      ...base,
      BUNNY_HOLE_RELAY_URL: "ws://relay.example",
    })
  );
  await assertRejects(() =>
    loadConnectorConfig({}, {
      ...base,
      BUNNY_HOLE_ORIGIN: "http://10.0.0.2",
    })
  );
  const local = await loadConnectorConfig(
    { "local-development": true, "allow-private-network": true },
    {
      ...base,
      BUNNY_HOLE_RELAY_URL: "ws://relay:8080",
      BUNNY_HOLE_ORIGIN: "http://origin:3000",
    },
  );
  assertEquals(local.localDevelopment, true);
  await assertRejects(() =>
    loadConnectorConfig({}, { ...base, BUNNY_HOLE_LOG_FORMAT: "verbose" })
  );
});

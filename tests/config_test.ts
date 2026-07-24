import { createSecret } from "../packages/protocol/auth.ts";
import { loadConnectorConfig } from "../apps/connector/config.ts";
import { loadRelayConfig, redactedConfig } from "../apps/relay/config.ts";
import { assertEquals, assertRejects, assertThrows } from "./assert.ts";

Deno.test("relay config is fail-closed and maps only explicit hostnames", () => {
  const secret = createSecret();
  const config = loadRelayConfig({
    BUNNY_HOLE_TUNNELS: JSON.stringify([
      { id: "alpha", secret, hostnames: ["A.Example.com"] },
    ]),
  });
  assertEquals(config.hostnameToTunnel.get("a.example.com"), "alpha");
  assertEquals(config.hostnameToTunnel.get("b.example.com"), undefined);
  assertEquals(
    (redactedConfig(config).tunnels as Record<string, unknown>[])[0].secret,
    "[REDACTED]",
  );
  assertThrows(() => loadRelayConfig({}), /required/);
  assertThrows(() =>
    loadRelayConfig({
      BUNNY_HOLE_TUNNELS: JSON.stringify([
        { id: "one", secret, hostnames: ["same.example"] },
        { id: "two", secret, hostnames: ["same.example"] },
      ]),
    })
  );
});

Deno.test("connector config requires WSS and explicit private-network opt-in", async () => {
  const secret = createSecret();
  const base = {
    BUNNY_HOLE_RELAY_URL: "wss://relay.example",
    BUNNY_HOLE_TUNNEL_ID: "alpha",
    BUNNY_HOLE_TUNNEL_SECRET: secret,
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
});

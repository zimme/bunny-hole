import { createSecret } from "../packages/protocol/auth.ts";
import { loadRelayConfig } from "../apps/relay/config.ts";
import { Relay } from "../apps/relay/relay.ts";
import { assertEquals } from "./assert.ts";

const logger = { info() {}, warn() {}, error() {} };
const config = loadRelayConfig({
  BUNNY_HOLE_LOCAL_DEVELOPMENT: "true",
  BUNNY_HOLE_TUNNELS: JSON.stringify([{
    id: "alpha",
    secret: createSecret(),
    hostnames: ["alpha.example"],
  }]),
});

Deno.test("health and readiness transition during graceful shutdown", async () => {
  const relay = new Relay(config, logger);
  assertEquals((await relay.handle(new Request("http://relay/healthz"))).status, 200);
  assertEquals((await relay.handle(new Request("http://relay/readyz"))).status, 200);
  relay.shutdown();
  assertEquals((await relay.handle(new Request("http://relay/healthz"))).status, 200);
  assertEquals((await relay.handle(new Request("http://relay/readyz"))).status, 503);
});

Deno.test("public requests route only by configured hostname", async () => {
  const relay = new Relay(config, logger);
  const unknown = await relay.handle(
    new Request("http://relay/path", { headers: { host: "other.example" } }),
  );
  assertEquals(unknown.status, 404);
  const offline = await relay.handle(
    new Request("http://relay/path", { headers: { host: "alpha.example" } }),
  );
  assertEquals(offline.status, 503);
  const confused = await relay.handle(
    new Request("http://relay/path", {
      headers: { host: "alpha.example.evil.example" },
    }),
  );
  assertEquals(confused.status, 404);
});

Deno.test("control endpoint does not accept normal HTTP or arbitrary tunnel IDs", async () => {
  const relay = new Relay(config, logger);
  assertEquals(
    (await relay.handle(new Request("http://relay/_bunny/connect?id=unknown"))).status,
    400,
  );
  assertEquals(
    (await relay.handle(
      new Request("http://relay/_bunny/connect?id=alpha", { method: "POST" }),
    )).status,
    405,
  );
});

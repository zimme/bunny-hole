import { createConnector, VERSION } from "../apps/connector/mod.ts";
import { validateConnectorOptions } from "../apps/connector/library.ts";
import { createSecret } from "../packages/protocol/auth.ts";
import { assertEquals, assertRejects, assertThrows } from "./assert.ts";

const base = {
  relayUrl: "wss://relay.example",
  tunnelId: "library-test",
  secret: createSecret(),
};

Deno.test("connector library validates without connecting or side effects", async () => {
  assertEquals(VERSION, "0.1.0");
  const validated = validateConnectorOptions(base);
  assertEquals(validated.relayUrl.href, "wss://relay.example/");
  assertEquals(validated.origin.href, "http://127.0.0.1:3000/");

  const connector = createConnector(base);
  assertEquals(typeof connector.run, "function");
  assertEquals(typeof connector.stop, "function");
  connector.stop();
  await assertRejects(() => connector.run(), /stopped/);
});

Deno.test("connector library preserves secure network defaults", () => {
  assertThrows(
    () => createConnector({ ...base, relayUrl: "ws://relay.example" }),
    /WSS/,
  );
  assertThrows(
    () => createConnector({ ...base, origin: "http://10.0.0.1" }),
    /loopback/,
  );
  assertThrows(
    () => createConnector({ ...base, tunnelId: "../victim" }),
    /tunnel ID/,
  );
  assertThrows(
    () => createConnector({ ...base, secret: "too-short" }),
    /secret/,
  );

  const privateOrigin = validateConnectorOptions({
    ...base,
    origin: "http://10.0.0.1:8080",
    allowPrivateNetwork: true,
  });
  assertEquals(privateOrigin.origin.href, "http://10.0.0.1:8080/");
});

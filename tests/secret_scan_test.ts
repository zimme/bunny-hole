import { containsSecret } from "../scripts/secret_scan.ts";
import { assertEquals } from "./assert.ts";

Deno.test("secret scan recognizes serialized Bunny Hole private keys", () => {
  assertEquals(
    containsSecret(JSON.stringify({ privateKey: "A".repeat(43) })),
    true,
  );
  assertEquals(
    containsSecret(JSON.stringify({ publicKey: "A".repeat(43) })),
    false,
  );
});
